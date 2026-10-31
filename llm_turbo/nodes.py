from __future__ import annotations

# Adapted from KingManiya/ComfyUI-LLM-text-processor (GPL-3.0).
# Modified for Elvax LLM Turbo on 2026-09-24.


import json
import logging
import math
import time
from pathlib import Path

import comfy.model_management
from comfy_api.latest import io
from .llama_binary import backend_options, custom_build_options, resolve_binary, _binary_signature, NO_CUSTOM_BUILD
from .llama_server import server

from .llama_cli import (
    FLASH_ATTENTION_OPTIONS,
    KV_CACHE_OPTIONS,
    MAX_LLAMA_SEED,
    build_command,
    run_llama_cli,
)
from .model_registry import (
    NO_MMPROJ,
    NO_MTP_MODEL,
    gguf_paths,
    full_mtp_model_path,
    full_mmproj_path,
    full_model_path,
    mmproj_options,
    model_options,
    mtp_model_options,
)


def _load_inference_presets(path):
    presets = [{"name": "Custom"}]
    logger = logging.getLogger(__name__)
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        logger.warning("[LLM Turbo] Could not load inference presets from %s: %s. Using Custom.", path, exc)
        return {"presets": presets}
    if not isinstance(data, dict) or not isinstance(data.get("presets"), list):
        logger.warning('[LLM Turbo] Inference presets must contain a "presets" list. Using Custom.')
        return {"presets": presets}
    names = {"Custom"}
    settings = ("temperature", "top_k", "top_p", "min_p", "repeat_penalty", "presence_penalty")
    for preset in data["presets"]:
        if isinstance(preset, dict) and preset.get("name") == "Custom":
            continue
        name = preset.get("name") if isinstance(preset, dict) else None
        values = preset.get("values") if isinstance(preset, dict) else None
        valid = isinstance(name, str) and bool(name.strip()) and name not in names and isinstance(values, dict)
        if valid:
            try:
                valid = all(type(values.get(key)) in (int, float) and math.isfinite(values[key]) for key in settings)
            except OverflowError:
                valid = False
            valid = valid and type(values.get("top_k")) is int
        if not valid:
            logger.warning("[LLM Turbo] Skipping invalid or duplicate inference preset: %r. Check %s.", name, path)
            continue
        names.add(name)
        presets.append({"name": name, "values": {key: values[key] for key in settings}})
    return {"presets": presets}


INFERENCE_PRESETS = _load_inference_presets(Path(__file__).resolve().parent / "inference_presets.json")

IMAGE_INPUT_NAMES = [f"image_{index}" for index in range(1, 10)]
AUDIO_INPUT_NAMES = [f"audio_{index}" for index in range(1, 10)]


class LLMTurbo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        models = gguf_paths()
        images = io.Autogrow.TemplateNames(
            input=io.Image.Input(
                "image",
                tooltip="(needs GGUF model with vision support like Qwen or Gemma)"),
            names=IMAGE_INPUT_NAMES,
            min=0,
        )
        audios = io.Autogrow.TemplateNames(
            input=io.Audio.Input(
                "audio",
                tooltip="(needs GGUF model with audio input support like Gemma4 12b)"),
            names=AUDIO_INPUT_NAMES,
            min=0,
        )
        return io.Schema(
            node_id="ElvaxLLMTurbo",
            display_name="LLM Turbo",
            category="Elvax",
            search_aliases=["elvax"],
            description=(
                "Run a local GGUF model through llama.cpp for fast inference in "
                "ComfyUI. Use dynamically growing image and audio inputs, "
                "including image batches, alongside system and user prompts. "
                "Supports MTP."),
            inputs=[
                io.Combo.Input(
                    "model", options=model_options(models),
                    tooltip='GGUF LLM model, put in "models/LLM" or "models/text_encoders" folders.'),
                io.Combo.Input(
                    "mmproj", options=mmproj_options(models), default=NO_MMPROJ,
                    tooltip=(
                        "Projector GGUF for image or audio input for models that support those. "
                        "Put in the same folder as the GGUF model.")),
                io.Combo.Input(
                    "mtp_model", options=mtp_model_options(models),
                    default=NO_MTP_MODEL,
                    tooltip=(
                        "Optional MTP GGUF draft model for speculative decoding, for models that "
                        "support it. Put in the same folder as the GGUF model.")),
                io.String.Input("system_prompt", default="", multiline=True,
                                dynamic_prompts=True),
                io.Int.Input("seed", default=1, min=-1, max=MAX_LLAMA_SEED),
                io.String.Input("user_prompt", default="Describe this image in detail.",
                                multiline=True, dynamic_prompts=True),
                io.Combo.Input("inference_preset", socketless=True,
                               options=[preset["name"] for preset in INFERENCE_PRESETS["presets"]],
                               extra_dict={"elvax_presets": INFERENCE_PRESETS["presets"]},
                               default="Custom",
                               tooltip='Apply your model preset. Add or edit presets in "ComfyUI/custom_nodes/Elvax-nodes/llm_turbo/inference_presets.json". Restart ComfyUI to apply changes.'),
                io.Float.Input("temperature", socketless=True, default=0.8, min=0.0, max=2.0, step=0.05),
                io.Int.Input("top_k", socketless=True, default=40, min=1, max=1000),
                io.Float.Input("top_p", socketless=True, default=0.95, min=0.0, max=1.0, step=0.01),
                io.Float.Input("min_p", socketless=True, default=0.05, min=0.0, max=1.0, step=0.01),
                io.Float.Input("repeat_penalty", socketless=True, default=1.0, min=0.0, max=3.0, step=0.01),
                io.Float.Input("presence_penalty", socketless=True, default=0.0, step=0.01),
                io.Int.Input(
                    "context_window_size", socketless=True, default=8192, min=512, max=1048576,
                    step=512,
                    tooltip="Context window size in tokens. Larger values use more memory."),
                io.Int.Input("max_tokens", socketless=True, default=2048, min=1, max=32768),
                io.Combo.Input("reasoning", socketless=True, options=["auto", "on", "off"], default="off"),
                io.Autogrow.Input(
                    "images", optional=True, template=images,
                    tooltip="(needs GGUF model with vision support like Qwen or Gemma)"),
                io.Autogrow.Input(
                    "audios", optional=True, template=audios,
                    tooltip="(needs GGUF model with audio input support like Gemma4 12b)"),
                io.Combo.Input(
                    "flash_attention", socketless=True, options=list(FLASH_ATTENTION_OPTIONS),
                    default="auto",
                    tooltip="Flash Attention can speed up inference and reduce VRAM usage on supported GPUs. Auto enables it when supported."),
                io.Combo.Input(
                    "kv_cache", socketless=True, options=list(KV_CACHE_OPTIONS),
                    default=KV_CACHE_OPTIONS[0],
                    tooltip="Set the KV cache quantization for the main model and MTP model. Lower precision reduces memory usage but may affect quality."),
                io.Combo.Input("gpu_backend", socketless=True, options=backend_options(), default=backend_options()[0],
                               tooltip="Choose the GPU backend. Select Custom to use your own llama.cpp build."),
                io.Combo.Input("custom_build", socketless=True, options=custom_build_options(),
                               tooltip='Place each custom llama.cpp build in its own folder inside "ComfyUI/custom_nodes/Elvax-nodes/llm_turbo/custom_builds/" then reload Comfy and select it from here\n(Include both llama-cli and llama-server files).'),
                io.Int.Input("timeout_seconds", socketless=True, default=300, min=10, max=3600),
                io.Boolean.Input("auto_unload", socketless=True, default=True,
                                 tooltip="true: unload after each run. false: keep the model loaded in memory for reuse."),
            ],
            outputs=[
                io.String.Output("response"),
                io.String.Output("reasoning"),
                io.String.Output(
                    "stats",
                    tooltip=(
                        "Shows total node time, prompt speed, generation speed, and generated tokens.")),
            ],
        )

    @classmethod
    def VALIDATE_INPUTS(cls, custom_build, gpu_backend):
        return True if gpu_backend in backend_options() else "Select a supported GPU backend."

    @classmethod
    def IS_CHANGED(cls, model, mmproj, mtp_model=NO_MTP_MODEL, gpu_backend=None, custom_build=NO_CUSTOM_BUILD, auto_unload=True, **kwargs):
        models = gguf_paths()
        paths = [full_model_path(model, models)]
        project = full_mmproj_path(mmproj, models)
        if project is not None:
            paths.append(project)
        mtp = full_mtp_model_path(mtp_model, models)
        if mtp is not None:
            paths.append(mtp)
        signature = tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths)
        if gpu_backend == "Custom":
            return signature, _binary_signature(resolve_binary("Custom", custom_build, server=not auto_unload))
        return signature

    @classmethod
    def execute(
        cls,
        model: str,
        mmproj: str,
        system_prompt: str,
        user_prompt: str,
        context_window_size: int,
        max_tokens: int,
        temperature: float,
        top_k: int,
        top_p: float,
        min_p: float,
        repeat_penalty: float,
        presence_penalty: float,
        seed: int,
        timeout_seconds: int,
        reasoning: str,
        images=None,
        audios=None,
        mtp_model: str = NO_MTP_MODEL,
        flash_attention: str = "auto",
        kv_cache: str = KV_CACHE_OPTIONS[0],
        gpu_backend: str = backend_options()[0],
        custom_build: str = NO_CUSTOM_BUILD,
        auto_unload: bool = True,
        inference_preset: str = "Custom",
    ):
        with server.lock:
            started = time.perf_counter()
            if auto_unload:
                server.stop()
            comfy.model_management.unload_all_models()
            executable = resolve_binary(gpu_backend, custom_build, server=not auto_unload)
            models = gguf_paths()
            command, cleanup_paths = build_command(
                model_path=full_model_path(model, models),
                mmproj_path=full_mmproj_path(mmproj, models),
                system_prompt=system_prompt,
                images=images,
                audio=audios,
                user_prompt=user_prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                min_p=min_p,
                repeat_penalty=repeat_penalty,
                presence_penalty=presence_penalty,
                context_window_size=context_window_size,
                seed=seed,
                reasoning=reasoning,
                mtp_model_path=full_mtp_model_path(mtp_model, models),
                flash_attention=flash_attention,
                kv_cache=kv_cache,
                executable=executable,
            )
            if auto_unload:
                response, reasoning_text, perf = run_llama_cli(command, timeout_seconds, cleanup_paths)
            else:
                try:
                    response, reasoning_text, perf = server.request(command, timeout_seconds)
                finally:
                    for path in cleanup_paths:
                        if path:
                            path.unlink(missing_ok=True)
            stats = f"Node generation time: {time.perf_counter() - started:.2f} s\n\n{perf}"
            return io.NodeOutput(response, reasoning_text, stats)
