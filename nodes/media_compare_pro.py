import asyncio
from glob import escape
import json
import re
from pathlib import Path
import uuid
import threading

import av
from aiohttp import web
from PIL import Image
import folder_paths
from comfy_api.latest import InputImpl, io, ui
import torch
from server import PromptServer


CAPTURE_SUBFOLDER = "Elvax/media_compare_pro"
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".opus", ".m4a"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
SETTING_LABELS = {
    "seed": "Seed", "noise_seed": "Seed", "sampler_name": "Sampler",
    "scheduler": "Scheduler", "steps": "Steps", "cfg": "CFG",
    "cfg_scale": "CFG", "denoise": "Denoise", "denoise_strength": "Denoise",
    "ckpt_name": "Model", "unet_name": "Model", "model_name": "Model",
}


def _linked_nodes(value, prompt):
    if isinstance(value, (list, tuple)):
        if len(value) == 2 and str(value[0]) in prompt and isinstance(value[1], int):
            yield str(value[0])
        else:
            for item in value:
                yield from _linked_nodes(item, prompt)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _linked_nodes(item, prompt)


def _generation_settings(prompt, roots, workflow_id=None):
    if not isinstance(prompt, dict):
        return []
    visited = set()
    settings = {}
    seeds = {}
    lora_index = 0
    ordered_nodes = []

    def seed_source(node_id, key, seen):
        if node_id in seen:
            return None
        seen.add(node_id)
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            return None
        inputs = node.get("inputs", {})
        value = inputs.get(key)
        links = list(_linked_nodes(value, prompt))
        if links:
            source_id = links[0]
            source = prompt.get(source_id, {})
            source_inputs = source.get("inputs", {}) if isinstance(source, dict) else {}
            for source_key in ("seed", "noise_seed", "value"):
                if source_key in source_inputs:
                    return seed_source(source_id, source_key, seen)
            return None
        if value is None or isinstance(value, (list, tuple, dict)):
            return None
        return {"id": f"{node_id}:{key}", "type": node.get("class_type", "Node"),
                "title": (node.get("_meta") or {}).get("title") or node.get("class_type", "Node"),
                "workflow": workflow_id, "value": str(value)}

    def add(label, value):
        if value is None or isinstance(value, (list, tuple, dict)):
            return
        value = str(value)
        if value and value not in settings.setdefault(label, []):
            settings[label].append(value)

    def add_lora(name, strength=None, model_strength=None, clip_strength=None):
        nonlocal lora_index
        if not name or name == "None" or isinstance(name, (list, tuple, dict)):
            return
        values = []
        for label, value in (("strength", strength), ("strength:", model_strength),
                             ("clip strength", clip_strength)):
            if value is not None and not isinstance(value, (list, tuple, dict, bool)) and value != "":
                values.append(f"{label} {value}")
        lora_index += 1
        add(f"LoRA {lora_index}", (f"({', '.join(values)}) " if values else "") + str(name))

    def visit(node_id):
        node_id = str(node_id)
        if node_id in visited or node_id not in prompt:
            return
        visited.add(node_id)
        node = prompt[node_id]
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        if not isinstance(inputs, dict):
            return
        node_type = node.get("class_type", "Node")
        if node_type == "PixaromaLoraLoader":
            state = inputs.get("LoraLoaderState", {})
            if isinstance(state, str):
                try:
                    state = json.loads(state)
                except json.JSONDecodeError:
                    state = {}
            rows = state.get("loras", []) if isinstance(state, dict) else []
            if isinstance(rows, list):
                for row in rows:
                    if not isinstance(row, dict) or not row.get("on", True):
                        continue
                    strength = row.get("sm", row.get("strength", 1.0))
                    add_lora(row.get("name"), model_strength=strength,
                             clip_strength=row.get("sc", strength) if "clip" in inputs else None)
        lora_rows = {}
        for key, value in inputs.items():
            match = re.fullmatch(r"(?:loras|lora_stack)\.(\d+)\.(lora_name|lora|strength|strength_model|strength_clip|enabled|on)", key)
            if match:
                lora_rows.setdefault(int(match.group(1)), {})[match.group(2)] = value
            if key in SETTING_LABELS:
                if SETTING_LABELS[key] == "Seed":
                    seed = seed_source(node_id, key, set())
                    if seed:
                        seeds.setdefault(seed["id"], seed)
                elif SETTING_LABELS[key] != "Seed":
                    add(SETTING_LABELS[key], value)
            if key == "lora_name":
                add_lora(value, model_strength=inputs.get("strength_model"),
                         clip_strength=inputs.get("strength_clip"))
            if key in ("loras", "lora_stack"):
                rows = value if isinstance(value, (list, tuple)) else [value]
                for row in rows:
                    if isinstance(row, dict) and row.get("enabled", row.get("on", True)):
                        add_lora(row.get("lora_name", row.get("lora")),
                                 row.get("strength"), row.get("strength_model"),
                                 row.get("strength_clip"))
            match = re.fullmatch(r"lora_(\d+)_name", key)
            if match and value not in ("None", ""):
                index = match.group(1)
                add_lora(value, strength=inputs.get(f"lora_{index}_strength"),
                         model_strength=inputs.get(f"lora_{index}_model_strength"),
                         clip_strength=inputs.get(f"lora_{index}_clip_strength"))
            match = re.fullmatch(r"lora_(\d+)", key)
            if match and isinstance(value, dict) and value.get("on", True):
                if node_type == "Power Lora Loader (rgthree)":
                    strength = value.get("strength")
                    clip_strength = value.get("strengthTwo")
                    if clip_strength is None:
                        clip_strength = strength
                    add_lora(value.get("lora"), model_strength=strength,
                             clip_strength=clip_strength if inputs.get("clip") is not None else None)
                else:
                    add_lora(value.get("lora"), value.get("strength"),
                             value.get("strength_model"), value.get("strength_clip"))
        for row in lora_rows.values():
            if row.get("enabled", row.get("on", True)):
                add_lora(row.get("lora_name", row.get("lora")), row.get("strength"),
                         row.get("strength_model"), row.get("strength_clip"))
        for value in inputs.values():
            for source_id in _linked_nodes(value, prompt):
                visit(source_id)
        ordered_nodes.append(node_id)

    for root in roots:
        visit(root)

    def sampling_node(node_id):
        node = prompt[node_id]
        if not isinstance(node, dict):
            return False
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            return False
        return (("latent_image" in inputs and ("sampler_name" in inputs or
                 ("sampler" in inputs and "sigmas" in inputs))) or
                ("sampler" in node.get("class_type", "").lower() and "sampler_settings" in inputs))

    stage_labels = ("Steps", "Sampler", "Scheduler", "CFG", "Denoise")

    def stage_settings(node_id, seen):
        if node_id in seen:
            return {}
        seen.add(node_id)
        result = {}
        node = prompt[node_id]
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        if not isinstance(inputs, dict):
            return result
        for key, value in inputs.items():
            label = SETTING_LABELS.get(key)
            if label in stage_labels:
                links = list(_linked_nodes(value, prompt))
                if links:
                    value = prompt[links[0]].get("inputs", {}).get("value")
                if value is not None and not isinstance(value, (list, tuple, dict)):
                    result[label] = str(value)
            if key in ("sampler", "sigmas", "noise", "guider", "sampler_settings", "chain_settings"):
                for source_id in _linked_nodes(value, prompt):
                    if not sampling_node(source_id):
                        for name, setting in stage_settings(source_id, seen).items():
                            result.setdefault(name, setting)
        return result

    stages = [stage_settings(node_id, set()) for node_id in ordered_nodes if sampling_node(node_id)]
    staged = set()
    if stages:
        for label in stage_labels:
            settings.pop(label, None)
            if any(label in stage for stage in stages):
                settings[label] = [stage.get(label, "Unknown") for stage in stages]
                staged.add(label)
    result = [{"name": name, "values": values, **({"staged": True} if name in staged else {})}
              for name, values in sorted(settings.items())]
    if seeds:
        sources = list(seeds.values())
        result.append({"name": "Seed", "values": [seed["value"] for seed in sources],
                       "labels": [seed["title"] for seed in sources], "sources": sources})
    return result


def _file_generation_settings(path, source_name=None):
    try:
        if path.suffix.lower() in IMAGE_EXTENSIONS:
            with Image.open(path) as image:
                metadata = dict(image.info)
                exif = image.getexif()
                for value in exif.values():
                    if isinstance(value, str) and value.startswith(("prompt:", "workflow:")):
                        key, content = value.split(":", 1)
                        metadata[key] = content
                width, height = image.size
                if exif.get(0x0112) in (5, 6, 7, 8):
                    width, height = height, width
                technical = [{"name": "Final resolution", "values": [f"{width} × {height}"]}]
        else:
            with av.open(str(path)) as container:
                metadata = dict(container.metadata)
                stream = container.streams.video[0] if container.streams.video else None
                technical = []
                if path.suffix.lower() in AUDIO_EXTENSIONS and container.streams.audio:
                    audio = container.streams.audio[0]
                    technical.append({"name": "Sample rate", "values": [f"{audio.rate} Hz"]})
                    if container.duration:
                        technical.append({"name": "Duration", "values": [f"{container.duration / av.time_base:.3f} s"]})
                if stream:
                    technical.append({"name": "Final resolution", "values": [f"{stream.width} × {stream.height}"]})
                    if stream.average_rate:
                        technical.append({"name": "Frame rate", "values": [str(stream.average_rate)]})
                    duration = stream.duration * stream.time_base if stream.duration and stream.time_base else None
                    if duration:
                        technical.append({"name": "Duration", "values": [f"{float(duration):.3f} s"]})
    except (OSError, av.error.FFmpegError):
        return []
    prompt = None
    for key, value in metadata.items():
        if key == "prompt" or key.endswith(".prompt"):
            try:
                candidate = json.loads(value)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(candidate, dict):
                prompt = candidate
                break
    if not prompt:
        return technical
    video_name = Path(source_name).stem.casefold() if source_name else path.stem.casefold()
    candidates = []
    video_outputs = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        class_type = node.get("class_type", "").casefold()
        prefix = inputs.get("filename_prefix")
        if prefix and ("video" in class_type or "combine" in class_type or
                       (path.suffix.lower() in IMAGE_EXTENSIONS and "image" in class_type) or
                       (path.suffix.lower() in AUDIO_EXTENSIONS and "audio" in class_type)):
            video_outputs.append((0, node_id, inputs))
            prefix = Path(str(prefix)).name.casefold()
            if video_name.startswith(prefix):
                candidates.append((len(prefix), node_id, inputs))
    if not candidates:
        if len(video_outputs) != 1:
            return technical
        candidates = video_outputs
    longest = max(candidate[0] for candidate in candidates)
    matches = [candidate for candidate in candidates if candidate[0] == longest]
    if len(matches) != 1:
        return technical
    roots = []
    for key, value in matches[0][2].items():
        if key != "filename_prefix":
            roots.extend(_linked_nodes(value, prompt))
    try:
        workflow = json.loads(metadata.get("workflow", "{}"))
    except (TypeError, json.JSONDecodeError):
        workflow = {}
    workflow_id = workflow.get("id") if isinstance(workflow, dict) else None
    return technical + _generation_settings(prompt, roots, workflow_id)


def capture_video(video):
    directory = Path(folder_paths.get_temp_directory()) / CAPTURE_SUBFOLDER
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.mp4"
    path = directory / filename
    try:
        # Native save_to streams file-backed videos and preserves their audio and trims.
        video.save_to(str(path))
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {"filename": filename, "subfolder": CAPTURE_SUBFOLDER, "type": "temp"}


def source_media_path(entry):
    roots = {
        "input": folder_paths.get_input_directory(),
        "output": folder_paths.get_output_directory(),
        "temp": folder_paths.get_temp_directory(),
    }
    root = roots.get(entry.get("type", "input"))
    if root is None:
        raise ValueError("The selected media could not be accessed.")
    directory = Path(root).resolve()
    filename = entry.get("filename", "")
    if not isinstance(filename, str) or not filename:
        raise ValueError("No media is available from the connected node yet.")
    path = (directory / entry.get("subfolder", "") / filename).resolve()
    if not path.is_relative_to(directory) or path.suffix.lower() not in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS | AUDIO_EXTENSIONS:
        raise ValueError("The selected media could not be accessed.")
    if not path.is_file():
        raise FileNotFoundError("The source media file could not be found. Check that it still exists, then load it again.")
    return path


def _existing_media_reference(upload, source_name, cancelled=None):
    name = str(source_name).replace("\\", "/").rsplit("/", 1)[-1]
    for kind, directory in (("output", folder_paths.get_output_directory()),
                            ("input", folder_paths.get_input_directory())):
        root = Path(directory).resolve()
        def candidates():
            yield root / name
            for path in root.rglob(escape(name)):
                if path.parent != root:
                    yield path

        for candidate in candidates():
            if cancelled and cancelled.is_set():
                raise asyncio.CancelledError
            candidate = candidate.resolve()
            if not candidate.is_relative_to(root) or not candidate.is_file():
                continue
            if candidate.name.casefold() != name.casefold():
                continue
            try:
                if upload.stat().st_size != candidate.stat().st_size:
                    continue
                same = True
                with upload.open("rb") as first, candidate.open("rb") as second:
                    while True:
                        if cancelled and cancelled.is_set():
                            raise asyncio.CancelledError
                        chunk = first.read(1024 * 1024)
                        if chunk != second.read(1024 * 1024):
                            same = False
                            break
                        if not chunk:
                            break
                if same:
                    return candidate, {"filename": candidate.name,
                                       "subfolder": "" if candidate.parent == root else candidate.parent.relative_to(root).as_posix(), "type": kind}
            except OSError:
                continue
    return None


def _validate_uploaded_media(path):
    if path.suffix.lower() in IMAGE_EXTENSIONS:
        try:
            with Image.open(path) as image:
                image.verify()
        except (OSError, SyntaxError) as error:
            raise ValueError("The file does not contain a readable image.") from error
        return
    try:
        with av.open(str(path)) as container:
            if path.suffix.lower() in AUDIO_EXTENSIONS:
                if not container.streams.audio or next(container.decode(audio=0), None) is None:
                    raise ValueError("The file does not contain readable audio.")
                return
            if not container.streams.video or next(container.decode(video=0), None) is None:
                raise ValueError("The file does not contain a readable video.")
    except (OSError, av.error.FFmpegError) as error:
        kind = "audio" if path.suffix.lower() in AUDIO_EXTENSIONS else "video"
        raise ValueError(f"The file does not contain readable {kind}.") from error


@PromptServer.instance.routes.post("/elvax/media-compare-pro/upload")
async def upload_compare_media(request):
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "media":
        return web.json_response({"error": "Drop a video, image, or audio file."}, status=400)
    extension = Path(field.filename or "").suffix.lower()
    if extension not in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS | AUDIO_EXTENSIONS:
        return web.json_response({"error": "This media file format is not supported."}, status=400)
    directory = Path(folder_paths.get_temp_directory()) / CAPTURE_SUBFOLDER
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid.uuid4().hex}{extension}"
    complete = False
    cancelled = threading.Event()
    handler = asyncio.current_task()

    async def watch_disconnect():
        while True:
            await asyncio.sleep(.1)
            if request.transport is None or request.transport.is_closing():
                cancelled.set()
                handler.cancel()
                return

    async def worker(function, *args):
        task = asyncio.create_task(asyncio.to_thread(function, *args))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled.set()
            await asyncio.gather(task, return_exceptions=True)
            raise

    watcher = asyncio.create_task(watch_disconnect())
    try:
        with path.open("wb") as output:
            while chunk := await field.read_chunk(size=1024 * 1024):
                await worker(output.write, chunk)
        await worker(_validate_uploaded_media, path)
        existing = await worker(_existing_media_reference, path, field.filename, cancelled)
        source, result = existing if existing else (path, {"filename": path.name,
                                                           "subfolder": CAPTURE_SUBFOLDER, "type": "temp"})
        result["media_type"] = "image" if extension in IMAGE_EXTENSIONS else "audio" if extension in AUDIO_EXTENSIONS else "video"
        result["generation"] = await worker(_file_generation_settings, source, field.filename)
        if existing:
            path.unlink()
        complete = True
        return web.json_response(result)
    except (OSError, ValueError) as error:
        return web.json_response({"error": f"Could not load the dropped file: {error}"}, status=400)
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        if not complete:
            path.unlink(missing_ok=True)


@PromptServer.instance.routes.post("/elvax/media-compare-pro/capture")
async def capture_existing_media(request):
    try:
        entry = await request.json()
        path = source_media_path(entry)
    except (ValueError, TypeError, AttributeError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    # This route only accepts files in ComfyUI's media directories, never arbitrary paths.
    try:
        capture_directory = (Path(folder_paths.get_temp_directory()) / CAPTURE_SUBFOLDER).resolve()
        if path.suffix.lower() in IMAGE_EXTENSIONS | AUDIO_EXTENSIONS:
            result = dict(entry)
            result["media_type"] = "image" if path.suffix.lower() in IMAGE_EXTENSIONS else "audio"
        elif path.parent == capture_directory and re.fullmatch(r"[0-9a-f]{32}\.mp4", path.name):
            result = {"filename": path.name, "subfolder": CAPTURE_SUBFOLDER, "type": "temp"}
        else:
            result = await asyncio.to_thread(capture_video, InputImpl.VideoFromFile(str(path)))
        result["generation"] = entry.get("generation") or await asyncio.to_thread(_file_generation_settings, path)
    except (OSError, ValueError) as error:
        return web.json_response({"error": f"Could not prepare the media: {error}"}, status=400)
    return web.json_response(result)


class MediaComparePro(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxMediaComparePro",
            display_name="Media Compare Pro",
            category="Elvax Nodes/Utilities",
            search_aliases=["elvax", "before after", "comparison"],
            description="Compare videos, single images, or audio and inspect their generation differences. Drag and drop media or load connected inputs manually or automatically. Compare audio with audio only.",
            inputs=[
                io.MultiType.Input("before", types=[io.Video, io.Image, io.Audio], optional=True, tooltip="Connect media (video, image, or audio) to use as Before."),
                io.MultiType.Input("after", types=[io.Video, io.Image, io.Audio], optional=True, tooltip="Connect media (video, image, or audio) to use as After."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, before=None, after=None):
        def kind(value):
            return "image" if isinstance(value, torch.Tensor) else "audio" if isinstance(value, dict) else "video"
        for value in (before, after):
            if isinstance(value, torch.Tensor) and value.shape[0] != 1:
                raise ValueError("Connect a single image, not an image sequence.")
            if isinstance(value, dict) and value["waveform"].shape[0] != 1:
                raise ValueError("Connect a single audio clip.")
        if before is not None and after is not None and (kind(before) == "audio") != (kind(after) == "audio"):
            raise ValueError("Compare audio with audio only.")
        result = {}
        prompt = cls.hidden.prompt or {}
        workflow_id = (cls.hidden.extra_pnginfo or {}).get("workflow", {}).get("id")
        inputs = prompt.get(str(cls.hidden.unique_id), {}).get("inputs", {})
        for role, value in (("before", before), ("after", after)):
            if value is None:
                continue
            media_type = kind(value)
            if media_type == "video":
                entry = capture_video(value)
            elif media_type == "image":
                entry = dict(ui.ImageSaveHelper.save_images(value, f"{CAPTURE_SUBFOLDER}/{uuid.uuid4().hex}", io.FolderType.temp, cls)[0])
            else:
                entry = dict(ui.AudioSaveHelper.save_audio(value, f"{CAPTURE_SUBFOLDER}/{uuid.uuid4().hex}", io.FolderType.temp, cls, format="flac")[0])
            entry["media_type"] = media_type
            settings = _generation_settings(prompt, _linked_nodes(inputs.get(role), prompt), workflow_id)
            file_settings = _file_generation_settings(source_media_path(entry))
            entry["generation"] = settings + [item for item in file_settings if item["name"] in ("Final resolution", "Frame rate", "Duration", "Sample rate")] if settings else file_settings
            result[f"elvax_compare_pro_{role}_media"] = [entry]
        return io.NodeOutput(ui=result)
