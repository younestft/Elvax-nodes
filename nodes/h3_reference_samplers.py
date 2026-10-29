"""Standalone MiniMax H3 reference samplers for Elvax-nodes.

The reference-input bundle follows the public H3_PROMPT_REFERENCES contract
used by ComfyUI-H3-Prompt-IDE. Its reference-input implementation is adapted
from that GPL-3.0 project; see the attribution below and the pack LICENSE.
"""

import logging
import math
import json
import os
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from threading import Lock

import comfy.model_management
import comfy.patcher_extension
import folder_paths
import latent_preview
import nodes
import node_helpers
from server import PromptServer
from comfy_api.latest import InputImpl, Types, io
from comfy_execution.graph_utils import ExecutionBlocker
from comfy_extras.nodes_audio import vae_decode_audio
from comfy_extras.nodes_custom_sampler import (
    Guider_Basic,
    Noise_RandomNoise,
    SamplerCustomAdvanced,
)
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo, _resize, _encode_ref_audio, _empty_av_latent, adapt_canvas, temporal_shape

from .h3_extension_sampler import (
    H3ExtensionBridge,
    H3ExtensionLatentTrim,
    MiniMaxH3MotionContextTrim,
    _decode_video_frames,
)


# Shared wire type and payload format with ethanfel/ComfyUI-H3-Prompt-IDE.
H3_PROMPT_REFERENCES = io.Custom("H3_PROMPT_REFERENCES")
H3_CHAIN_SETTINGS = io.Custom("ELVAX_H3_CHAIN_SETTINGS")
H3_SAMPLER_SETTINGS = io.Custom("ELVAX_H3_SAMPLER_SETTINGS")
H3_PREPARED = io.Custom("ELVAX_H3_PREPARED")

PICTURE_NAMES = [f"<Picture {index}>" for index in range(1, 10)]
VIDEO_NAMES = [f"<Video {index}>" for index in range(1, 4)]
AUDIO_NAMES = [f"<Audio {index}>" for index in range(1, 7)]
MIN_H3_FRAMES = 5
MAX_H3_FRAMES = 362
H3_FPS = 24
H3_FRAME_STEP = 17


def _share_h3_references(data):
    prompt = data.get("prompt", {})
    groups = {}
    for node in list(prompt.values()):
        if node.get("class_type") != "ElvaxH3StageSettings":
            continue
        inputs = node["inputs"]
        if all(isinstance(inputs.get(key), list) and inputs[key][0] in prompt for key in ("prepared_base", "prepared_video")):
            continue
        if not all(isinstance(inputs.get(key), list) and len(inputs[key]) == 2 for key in ("chain_settings", "references")):
            continue
        key = json.dumps([inputs["chain_settings"], inputs["references"]])
        groups.setdefault(key, []).append(inputs)
    index = 0

    def add(inputs):
        nonlocal index
        while f"elvax_h3_refs_{index}" in prompt:
            index += 1
        node_id = f"elvax_h3_refs_{index}"
        index += 1
        prompt[node_id] = {"class_type": "ElvaxH3PrepareReferences", "inputs": inputs}
        return [node_id, 0]

    for stages in groups.values():
        if len(stages) < 2:
            continue
        first = stages[0]
        common = {key: first[key] for key in ("chain_settings", "references")}
        base = add({**common, "part": "base", "duration_s": 0})
        variants = {}
        for inputs in stages:
            duration = inputs.get("duration_s", 124 / H3_FPS)
            effective = _duration_to_h3_frames(duration) if isinstance(duration, (int, float)) else duration
            key = json.dumps(effective)
            if key not in variants:
                variants[key] = add({**common, "part": "video", "duration_s": duration, "base": base})
            inputs["prepared_base"] = base
            inputs["prepared_video"] = variants[key]
    return data


PromptServer.instance.add_on_prompt_handler(_share_h3_references)


def _duration_to_h3_frames(duration_s):
    """Round seconds to the next H3 frame count on the 17n+5 grid."""
    duration_s = float(duration_s)
    min_duration = MIN_H3_FRAMES / H3_FPS
    max_duration = MAX_H3_FRAMES / H3_FPS
    duration_s = min(max(duration_s, min_duration), max_duration)
    frames = max(MIN_H3_FRAMES, round(duration_s * H3_FPS))
    frames += (5 - frames % H3_FRAME_STEP) % H3_FRAME_STEP
    return min(frames, MAX_H3_FRAMES)


def _reference_records(source, names, kind, value_key):
    values = source or {}
    records = []
    for token in names:
        value = values.get(token)
        if value is not None:
            records.append({"token": token, "kind": kind, value_key: value})
    return records


def _slot_number(token, prefix, maximum):
    if not isinstance(token, str) or not token.startswith(prefix) or not token.endswith(">"):
        raise ValueError("h3_reference_sampler: malformed H3 reference token %r." % token)
    try:
        number = int(token[len(prefix):-1])
    except ValueError as exc:
        raise ValueError("h3_reference_sampler: malformed H3 reference token %r." % token) from exc
    if not 1 <= number <= maximum:
        raise ValueError("h3_reference_sampler: reference token %r is out of range." % token)
    return number


def _reference_slots(records, prefix, maximum):
    slots = {}
    for record in records:
        number = _slot_number(record.get("token"), prefix, maximum)
        if number in slots:
            raise ValueError("h3_reference_sampler: duplicate reference token %s%d>." % (prefix, number))
        slots[number] = record
    return dict(sorted(slots.items()))


def _native_reference_inputs(references):
    if not isinstance(references, dict) or not isinstance(references.get("references"), list):
        raise ValueError(
            "h3_reference_sampler: references must come from an H3 References node.")

    records = references["references"]
    if any(not isinstance(item, dict) for item in records):
        raise ValueError("h3_reference_sampler: malformed reference bundle record.")
    unknown_kinds = sorted(
        {item.get("kind") for item in records} - {"picture", "video", "audio"})
    if unknown_kinds:
        raise ValueError(
            "h3_reference_sampler: unsupported reference kind(s): %s."
            % ", ".join(str(kind) for kind in unknown_kinds))
    pictures = _reference_slots(
        [item for item in records if item.get("kind") == "picture"],
        "<Picture ", 9)
    videos = _reference_slots(
        [item for item in records if item.get("kind") == "video"],
        "<Video ", 3)
    audios = _reference_slots(
        [item for item in records if item.get("kind") == "audio"],
        "<Audio ", 6)

    # The native encoder numbers only connected references. Re-key media into
    # dense native slots and keep a token map so sparse Prompt IDE labels still
    # refer to the same media in the encoded prompt.
    ref_images = {}
    token_map = {}
    for native_number, (source_number, item) in enumerate(pictures.items(), 1):
        ref_images["ref_image_%d" % native_number] = item["image"]
        token_map["<Picture %d>" % source_number] = "<Picture %d>" % native_number

    ref_videos = {}
    native_video_numbers = {}
    for native_number, (source_number, item) in enumerate(videos.items(), 1):
        if "frames" not in item:
            raise ValueError(
                "h3_reference_sampler: <Video %d> has no frame data." % source_number)
        ref_videos["ref_video_%d" % native_number] = item["frames"]
        native_video_numbers[source_number] = native_number
        token_map["<Video %d>" % source_number] = "<Video %d>" % native_number

    # Audio 1-3 pair with matching video slots when present; without that video
    # they work as standalone audio. Audio 4-6 are always standalone. The
    # native encoder presents all connected soundtracks first, then standalone
    # audio, so translate source labels to that compact order.
    ref_video_audios = {}
    ref_audios = {}
    native_audio_number = 0
    standalone_number = 0
    soundtracks = {
        number: item for number, item in audios.items()
        if number <= 3 and number in videos
    }
    standalone = {
        number: item for number, item in audios.items()
        if number > 3 or number not in videos
    }
    for number, item in soundtracks.items():
        if "audio" not in item:
            raise ValueError(
                "h3_reference_sampler: <Audio %d> has no audio data." % number)
        native_audio_number += 1
        native_video_number = native_video_numbers[number]
        ref_video_audios["ref_video_audio_%d" % native_video_number] = item["audio"]
        token_map["<Audio %d>" % number] = "<Audio %d>" % native_audio_number

    for number, item in standalone.items():
        if "audio" not in item:
            raise ValueError(
                "h3_reference_sampler: <Audio %d> has no audio data." % number)
        native_audio_number += 1
        standalone_number += 1
        ref_audios["ref_audio_%d" % standalone_number] = item["audio"]
        token_map["<Audio %d>" % number] = "<Audio %d>" % native_audio_number

    return {
        "ref_images": ref_images,
        "ref_videos": ref_videos,
        "ref_video_audios": ref_video_audios,
        "ref_audios": ref_audios,
    }, token_map


def _build_reference_conditioning(
    clip, references, prompt, width, height, length, ref_image_size,
    video_vae, audio_vae, prepared=None,
):
    ref_inputs, token_map = _native_reference_inputs(references)
    prompt_tags = set(re.findall(r"<(Picture|Video|Audio) (\d+)>", prompt))
    prompt_tags = {"<%s %s>" % tag for tag in prompt_tags}
    missing = sorted(prompt_tags.difference(token_map))
    if missing:
        raise ValueError(
            "h3_reference_sampler: prompt uses unconnected reference token(s): %s."
            % ", ".join(missing))
    prompt = re.sub(
        r"<(Picture|Video|Audio) (\d+)>",
        lambda match: token_map.get(match.group(0), match.group(0)),
        prompt,
    )
    if prepared is not None:
        base, videos = prepared
        items = base["images"] + videos["items"] + base["audio_items"]
        blocks = base["blocks"] + videos["blocks"] + base["audio_blocks"]
        cond = clip.encode_from_tokens_scheduled(clip.tokenize(prompt, minimax_ref_items=items))
        if blocks:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": blocks})
        return cond, _empty_av_latent(width, height, length)[0]
    result = MiniMaxH3ReferenceToVideo.execute(
        clip=clip,
        prompt=prompt,
        width=width,
        height=height,
        length=length,
        ref_image_size=ref_image_size,
        vae=video_vae,
        audio_vae=audio_vae,
        **ref_inputs,
    )
    return result.result


class H3PrepareReferences(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ElvaxH3PrepareReferences", display_name="H3 Reference Preparation (internal)",
            category="Elvax/internal", search_aliases=["elvax"], inputs=[
                H3_CHAIN_SETTINGS.Input("chain_settings"), H3_PROMPT_REFERENCES.Input("references"),
                io.Combo.Input("part", options=["base", "video"]),
                io.Float.Input("duration_s", default=124 / H3_FPS),
                H3_PREPARED.Input("base", optional=True),
            ], outputs=[H3_PREPARED.Output("prepared")])

    @classmethod
    def execute(cls, chain_settings, references, part, duration_s, base=None):
        chain = chain_settings["chain"]
        inputs, _ = _native_reference_inputs(references)
        vae, audio_vae = chain["video_vae"], chain["audio_vae"]
        if part == "base":
            images, blocks, audio_items, audio_blocks, soundtracks = [], [], [], [], {}
            for image in inputs["ref_images"].values():
                h, w = image.shape[1:3]
                scale = min(1.0, math.sqrt(chain["width"] * chain["height"] / (w * h))) if chain["ref_image_size"] == "match" else min(1.0, 2048 / min(w, h))
                tw, th = max(32, round(w * scale / 32) * 32), max(32, round(h * scale / 32) * 32)
                resized = _resize(image[:1], tw, th, "disabled")
                images.append({"type": "image", "data": resized})
                blocks.append({"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": vae.encode(resized)})
            for name, audio in inputs["ref_video_audios"].items():
                soundtracks[name] = _encode_ref_audio(audio_vae, audio)
            for audio in inputs["ref_audios"].values():
                z, count = _encode_ref_audio(audio_vae, audio)
                audio_items.append({"type": "audio"})
                audio_blocks.append({"kind": "audio", "ref_audio_t": count, "audio_latent": z})
            return io.NodeOutput({"images": images, "blocks": blocks, "audio_items": audio_items,
                                  "audio_blocks": audio_blocks, "soundtracks": soundtracks})
        items, blocks = [], []
        frame_count = temporal_shape(_duration_to_h3_frames(duration_s))[0]
        for name, video in inputs["ref_videos"].items():
            vh, vw = video.shape[1:3]
            cw, ch = adapt_canvas(vw, vh)
            if vw * vh < cw * ch:
                cw, ch = max(32, round(vw / 32) * 32), max(32, round(vh / 32) * 32)
            frames = _resize(video, cw, ch, "disabled")[:frame_count]
            n = frames.shape[0]
            if n < 5:
                raise ValueError("MiniMax H3 reference videos need at least 5 frames (~0.2s at 24 fps)")
            n -= (n - 5) % 17
            frames = frames[:n]
            soundtrack = base["soundtracks"].get("ref_video_audio_" + name.rsplit("_", 1)[-1])
            if soundtrack is not None:
                items.append({"type": "audio"})
            indices = list(range(0, n, H3_FPS // 2))
            items.append({"type": "video", "data": frames[indices], "timestamps": [i / 2.0 for i in range(len(indices))]})
            z = vae.encode(frames)
            audio_latent, ref_audio_t = soundtrack if soundtrack is not None else (None, 0)
            blocks.append({"kind": "video_audio" if ref_audio_t else "video", "latent_t": z.shape[2],
                           "latent_h": ch // 16, "latent_w": cw // 16, "ref_audio_t": ref_audio_t,
                           "latent": z, "audio_latent": audio_latent})
        return io.NodeOutput({"items": items, "blocks": blocks})


def _sample(model, conditioning, latent, seed, sampler, sigmas):
    guider = Guider_Basic(model)
    guider.set_conds(conditioning)
    noise = Noise_RandomNoise(int(seed))
    return SamplerCustomAdvanced.sample(noise, guider, sampler, sigmas, latent)[0]


def _stage_preview(sampled_latent, video_vae, audio_vae, trim_frames, enabled):
    if not enabled:
        blocker = ExecutionBlocker(None)
        return blocker, blocker

    video, audio = H3ExtensionLatentTrim._streams(sampled_latent, "sampled_latent")
    images = _decode_video_frames(video_vae, video, "sampled")
    sound = vae_decode_audio(audio_vae, {"samples": audio})
    return MiniMaxH3MotionContextTrim().trim(
        images=images,
        trim_frames=trim_frames,
        audio=sound,
        fps=24,
        match_tail=True,
    )


class H3ReferenceInputs(io.ComfyNode):
    """Collect H3 media with the same custom bundle contract as H3 Prompt IDE.

    Adapted from ethanfel/ComfyUI-H3-Prompt-IDE, copyright Ethan Fel,
    distributed under GPL-3.0.
    """

    @classmethod
    def define_schema(cls):
        pictures = io.Autogrow.TemplateNames(
            input=io.Image.Input(
                "picture",
                tooltip=(
                    "Reference picture for the matching MiniMax H3 token. "
                    "The next socket appears automatically when connected."),
            ),
            names=PICTURE_NAMES,
            min=0,
        )
        videos = io.Autogrow.TemplateNames(
            input=io.Image.Input(
                "video",
                tooltip=(
                    "Reference video frames for the matching MiniMax H3 token. "
                    "Use the same IMAGE frame batch sent to the native H3 "
                    "ref_videos input."),
            ),
            names=VIDEO_NAMES,
            min=0,
        )
        audios = io.Autogrow.TemplateNames(
            input=io.Audio.Input(
                "audio",
                tooltip=(
                    "Reference audio for the matching MiniMax H3 token. Audio "
                    "labels follow native presentation order: connected video "
                    "soundtracks first, then standalone audio."),
            ),
            names=AUDIO_NAMES,
            min=0,
        )
        return io.Schema(
            node_id="ElvaxH3ReferenceInputs",
            display_name="H3 References",
            category="text/H3 Prompt IDE",
            search_aliases=[
                "elvax",
                "h3 ref input",
                "h3 reference media",
                "h3 reference images videos audio",
                "minimax picture video audio references",
            ],
            description=(
                "Bundle picture, video, and audio references with MiniMax H3 "
                "token labels for use in H3 Stage Settings."),
            inputs=[
                io.Autogrow.Input(
                    "pictures", optional=True, template=pictures,
                    tooltip=(
                        "Up to nine prompt reference pictures, numbered in "
                        "their H3 presentation order.")),
                io.Autogrow.Input(
                    "videos", optional=True, template=videos,
                    tooltip=(
                        "Up to three reference video frame batches, numbered "
                        "<Video 1> through <Video 3>.")),
                io.Autogrow.Input(
                    "audios", optional=True, template=audios,
                    tooltip=(
                        "Up to six emitted H3 audio labels: video soundtracks "
                        "first, then standalone audio.")),
            ],
            outputs=[
                H3_PROMPT_REFERENCES.Output(
                    "references",
                    tooltip="Authoring references for H3 Prompt IDE."),
            ],
        )

    @classmethod
    def execute(cls, pictures=None, videos=None, audios=None):
        picture_records = _reference_records(
            pictures, PICTURE_NAMES, "picture", "image")
        video_records = _reference_records(
            videos, VIDEO_NAMES, "video", "frames")
        audio_records = _reference_records(
            audios, AUDIO_NAMES, "audio", "audio")
        return io.NodeOutput({
            "pictures": picture_records,
            "videos": video_records,
            "audios": audio_records,
            "references": picture_records + video_records + audio_records,
        })


class H3ChainSettings(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxH3ChainSettings",
            display_name="H3 Chain Settings",
            category="sampling/minimax",
            search_aliases=["elvax"],
            description=(
                "Configure the shared settings for a MiniMax H3 extension chain."),
            inputs=[
                io.Clip.Input("clip"),
                io.Vae.Input("video_vae"),
                io.Vae.Input("audio_vae"),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                io.Int.Input("width", default=1344, min=32, max=nodes.MAX_RESOLUTION, step=32),
                io.Int.Input("height", default=768, min=32, max=nodes.MAX_RESOLUTION, step=32),
                io.Combo.Input(
                    "ref_image_size",
                    options=["match", "max"],
                    default="match",
                    tooltip=(
                        "Reference image sizing. 'match' scales each ref "
                        "(down only, keeping aspect) to the generation's pixel "
                        "area; 'max' uses the reference pipeline's 2048px short "
                        "edge for best identity fidelity. Reference tokens ride "
                        "through every sampling step, so 'max' can be several "
                        "times slower.")),
            ],
            outputs=[H3_CHAIN_SETTINGS.Output("chain_settings")],
        )

    @classmethod
    def execute(cls, clip, video_vae, audio_vae, sampler, sigmas,
                width, height, ref_image_size):
        return io.NodeOutput({
            "version": 1,
            "chain": {
                "clip": clip,
                "video_vae": video_vae,
                "audio_vae": audio_vae,
                "sampler": sampler,
                "sigmas": sigmas,
                "width": int(width),
                "height": int(height),
                "ref_image_size": ref_image_size,
            },
        })


class H3StageSettings(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxH3StageSettings",
            display_name="H3 Stage Settings",
            category="sampling/minimax",
            search_aliases=["elvax"],
            description=(
                "Configure each stage of a MiniMax H3 extension chain independently."),
            inputs=[
                H3_CHAIN_SETTINGS.Input("chain_settings"),
                io.Model.Input(
                    "model",
                    tooltip="You can connect this stage's custom Loras here"),
                H3_PROMPT_REFERENCES.Input("references", optional=True),
                H3_PREPARED.Input("prepared_base", optional=True),
                H3_PREPARED.Input("prepared_video", optional=True),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input(
                    "seed", default=0, min=0, max=0xffffffffffffffff,
                    control_after_generate=True),
                io.Float.Input(
                    "duration_s",
                    default=124 / H3_FPS,
                    min=MIN_H3_FRAMES / H3_FPS,
                    max=MAX_H3_FRAMES / H3_FPS,
                    step=H3_FRAME_STEP / H3_FPS,
                    tooltip=(
                        "Duration in seconds. typed values round up to the "
                        "closest valid H3 length when sampling.")),
                io.Combo.Input(
                    "transition_mode",
                    options=["motion context", "hard cut"],
                    default="motion context",
                    tooltip=(
                        "Motion Context continues from the prior latent context. "
                        "Hard Cut starts a new joined video")),
                io.Int.Input(
                    "video_context_length", default=22, min=5, max=56, step=17,
                    tooltip=(
                        "Motion Context video window. Supported values: "
                        "5, 22, 39, 56.")),
                io.Int.Input(
                    "audio_context_length", default=24, min=0, max=240, step=1,
                    tooltip="Motion Context audio window; 24 is about one second at 24 fps."),
            ],
            outputs=[H3_SAMPLER_SETTINGS.Output("sampler_settings")],
        )

    @classmethod
    def execute(cls, chain_settings, model, prompt, seed, duration_s,
                transition_mode, video_context_length, audio_context_length,
                references=None, prepared_base=None, prepared_video=None):
        if (not isinstance(chain_settings, dict)
                or chain_settings.get("version") != 1
                or "chain" not in chain_settings):
            raise ValueError(
                "h3_stage_settings: connect H3 Chain Settings to "
                "chain_settings.")
        settings = {
            "version": 1,
            "chain": chain_settings["chain"],
            "stage": {
                "model": model,
                "references": references,
                "prepared": (prepared_base, prepared_video) if prepared_base is not None and prepared_video is not None else None,
                "prompt": prompt,
                "seed": int(seed),
                "duration_s": float(duration_s),
                "transition_mode": transition_mode,
                "video_context_length": int(video_context_length),
                "audio_context_length": int(audio_context_length),
            },
        }
        return io.NodeOutput(settings)


def _sample_h3_stage(sampler_settings, previous_latent):
    if (not isinstance(sampler_settings, dict)
            or sampler_settings.get("version") != 1
            or "stage" not in sampler_settings):
        raise ValueError(
            "h3_sampler_preview: connect H3 Stage Settings to "
            "sampler_settings before sampling.")
    chain = sampler_settings["chain"]
    stage = sampler_settings["stage"]
    duration_frames = _duration_to_h3_frames(stage["duration_s"])
    conditioning, base_latent = _build_reference_conditioning(
        chain["clip"], stage["references"], stage["prompt"],
        chain["width"], chain["height"], duration_frames,
        chain["ref_image_size"], chain["video_vae"], chain["audio_vae"], stage.get("prepared"))

    trim_frames = 0
    if previous_latent is None:
        sampled_latent = _sample(
            stage["model"], conditioning, base_latent, stage["seed"],
            chain["sampler"], chain["sigmas"])
        chain_latent = sampled_latent
    else:
        transition_mode = stage["transition_mode"]
        if transition_mode == "motion context":
            conditioning, base_latent, trim_frames = H3ExtensionBridge().bridge(
                previous_latent=previous_latent,
                conditioning=conditioning,
                latent=base_latent,
                video_vae=chain["video_vae"],
                context_length=str(stage["video_context_length"]),
                audio_context_length=stage["audio_context_length"],
            )
        elif transition_mode == "hard cut":
            H3ExtensionLatentTrim.validate_compatible(
                base_latent, previous_latent)
            trim_frames = 5
        else:
            raise ValueError(
                "h3_sampler_preview: unsupported transition mode %r."
                % transition_mode)

        sampled_latent = _sample(
            stage["model"], conditioning, base_latent, stage["seed"],
            chain["sampler"], chain["sigmas"])
        chain_latent, _stage_latent = H3ExtensionLatentTrim().trim_latent_and_stage(
            sampled_latent,
            trim_frames,
            previous_latent,
            hard_cut=transition_mode == "hard cut",
        )

    return chain_latent, sampled_latent, trim_frames, chain


class _H3LivePreview:
    def __init__(self, preview_module, tiny_vae, node_id):
        self.preview_module = preview_module
        self.tiny_vae = tiny_vae
        self.node_id = str(node_id)

    def __call__(self, executor, noise, latent_image, sampler, sigmas,
                 denoise_mask, callback, disable_pbar, seed, latent_shapes):
        preview = self.preview_module
        model_patcher = executor.class_obj.model_patcher
        latent_format = model_patcher.model.latent_format
        decoder = preview.load_tiny_vae_decoder(self.tiny_vae)
        if decoder is not None and latent_shapes and int(latent_shapes[0][1]) != decoder.latent_channels:
            logging.warning("H3 live preview: tiny VAE channel mismatch; using latent RGB previews")
            decoder = None
        client_id = preview.PromptServer.instance.client_id
        pending = None
        revision = 0
        revision_lock = Lock()

        def encode_frames(frames, frame_revision):
            try:
                frames = preview._materialize_frames(frames, 1024)
                if not frames:
                    return
                image, width, height = (None, 0, 0)
                mime = "video/mp4"
                if preview._MP4_AVAILABLE:
                    image, width, height = preview._encode_mp4(frames, 12, 1024)
                if not image:
                    image, width, height = preview._encode_animated_webp(frames, 12, 80, 1024)
                    mime = "image/webp"
                if image:
                    with revision_lock:
                        if frame_revision == revision:
                            preview.PromptServer.instance.send_sync(
                                "kj_preview_override",
                                {"node_id": self.node_id, "image": image, "mime": mime,
                                 "w": width, "h": height, "fps": 12},
                                client_id,
                            )
            except Exception:
                logging.exception("H3 live preview encoding failed")

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="h3-preview") as encoder:
            def preview_callback(step, x0, x, total_steps):
                nonlocal pending, decoder, revision
                final_step = step + 1 == total_steps
                if final_step or pending is None or pending.done():
                    try:
                        video_latent = preview._normalize_packed_x0(x0, latent_shapes, 0)
                        frames = None
                        if decoder is not None:
                            try:
                                frames, _ = preview._tiny_vae_decode_frames(
                                    decoder, video_latent, max_frames=1024,
                                    compile_preview=latent_format.compile_preview)
                            except Exception:
                                logging.exception("H3 tiny VAE preview failed; using latent RGB previews")
                                decoder = None
                        if frames is None:
                            frames = preview._decode_video_frames_l2rgb(video_latent, latent_format, 1024)
                        if frames is not None and len(frames):
                            with revision_lock:
                                revision += 1
                                frame_revision = revision
                            pending = encoder.submit(encode_frames, frames, frame_revision)
                    except Exception:
                        logging.exception("H3 live preview decoding failed")
                if callback is not None:
                    callback(step, x0, x, total_steps)

            # Keep the existing KJ suppression of duplicate default previews, scoped
            # to this sampling call. The original callback still records x0/progress.
            previous_methods = []
            classes = [latent_preview.LatentPreviewer]
            seen = set()
            for preview_class in classes:
                if preview_class in seen:
                    continue
                seen.add(preview_class)
                classes.extend(preview_class.__subclasses__())
                if "decode_latent_to_preview_image" in preview_class.__dict__:
                    previous_methods.append((preview_class, preview_class.__dict__["decode_latent_to_preview_image"]))
                    preview_class.decode_latent_to_preview_image = preview._suppressed_preview_image
            try:
                return executor(
                    noise, latent_image, sampler, sigmas, denoise_mask,
                    preview_callback, disable_pbar, seed, latent_shapes=latent_shapes)
            finally:
                for preview_class, method in previous_methods:
                    preview_class.decode_latent_to_preview_image = method
                comfy.model_management.soft_empty_cache()


class H3SamplerPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxH3SamplerPreview",
            display_name="H3 Sampler Preview",
            category="sampling/minimax",
            search_aliases=["elvax"],
            description=(
                "Sample a stage, optionally show a live tiny-VAE preview during "
                "sampling or decode a full video preview, and pass the "
                "accumulated latent to the next stage."),
            inputs=[
                io.Latent.Input(
                    "previous_latent", optional=True,
                    tooltip=(
                        "Previous chain_latent from \"H3 Sampler Preview\" "
                        "(Leave unconnected for the first stage)")),
                H3_SAMPLER_SETTINGS.Input("sampler_settings"),
                io.Combo.Input(
                    "tiny_vae",
                    options=["none"] + folder_paths.get_filename_list("vae_approx"),
                    default="none",
                    tooltip=(
                        "Optional tiny VAE for live preview during sampling. "
                        "Place H3 tiny vae in: \"models\\vae_approx\".")),
                io.Boolean.Input(
                    "preview_result", default=True,
                    tooltip="Decode and preview this stage's video (takes time to decode it)"),
            ],
            outputs=[io.Latent.Output("chain_latent")],
            hidden=[io.Hidden.unique_id],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, sampler_settings, tiny_vae, preview_result,
                previous_latent=None):
        sampling_settings = sampler_settings
        if tiny_vae and tiny_vae != "none":
            kj_node = nodes.NODE_CLASS_MAPPINGS.get("ModelPreviewOverrideKJ")
            kj_module = sys.modules.get(kj_node.__module__) if kj_node else None
            if kj_module is None:
                raise RuntimeError(
                    "H3 Sampler Preview live previews require the "
                    "KJNodes Model Preview Override component.")

            sampling_settings = dict(sampler_settings)
            stage = dict(sampler_settings["stage"])
            model = stage["model"].clone()
            model.add_wrapper_with_key(
                comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
                "elvax_h3_sampler_preview",
                _H3LivePreview(kj_module, tiny_vae, cls.hidden.unique_id),
            )
            stage["model"] = model
            sampling_settings["stage"] = stage

        chain_latent, sampled_latent, trim_frames, chain = _sample_h3_stage(
            sampling_settings, previous_latent)
        if not preview_result:
            if tiny_vae and tiny_vae != "none":
                return io.NodeOutput(
                    chain_latent, ui={"elvax_h3_live_preview": [True]})
            return io.NodeOutput(chain_latent)

        images, audio = _stage_preview(
            sampled_latent, chain["video_vae"], chain["audio_vae"],
            trim_frames, True)
        video = InputImpl.VideoFromComponents(Types.VideoComponents(
            images=images,
            audio=audio,
            frame_rate=Fraction(H3_FPS),
        ))
        filename = f"elvax_h3_preview_{uuid.uuid4().hex}.mp4"
        video.save_to(
            os.path.join(folder_paths.get_temp_directory(), filename),
            format=Types.VideoContainer.MP4,
            codec="auto",
            preset="ultrafast",
        )
        preview = {
            "images": [{"filename": filename, "subfolder": "", "type": "temp"}],
            "animated": (True,),
        }
        return io.NodeOutput(chain_latent, ui={**preview, "elvax_h3_video": preview["images"]})
