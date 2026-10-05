from __future__ import annotations

# Adapted from KingManiya/ComfyUI-LLM-text-processor (GPL-3.0).
# Modified for Elvax LLM Turbo on 2026-09-24.

import time

import comfy.model_management
from comfy_api.latest import io

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
    full_mtp_model_path,
    full_mmproj_path,
    full_model_path,
    mmproj_options,
    model_options,
    mtp_model_options,
)


IMAGE_INPUT_NAMES = [f"image_{index}" for index in range(1, 10)]
AUDIO_INPUT_NAMES = [f"audio_{index}" for index in range(1, 10)]


class LLMTurbo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
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
                    "model", options=model_options(),
                    tooltip='GGUF LLM model, put in "models/LLM" or "models/text_encoders" folders.'),
                io.Combo.Input(
                    "mmproj", options=mmproj_options(), default=NO_MMPROJ,
                    tooltip=(
                        "Projector GGUF for image or audio input for models that support those. "
                        "Put in the same folder as the GGUF model.")),
                io.Combo.Input(
                    "mtp_model", options=mtp_model_options(),
                    default=NO_MTP_MODEL,
                    tooltip=(
                        "Optional MTP GGUF draft model for speculative decoding, for models that "
                        "support it. Put in the same folder as the GGUF model.")),
                io.String.Input("system_prompt", default="", multiline=True,
                                dynamic_prompts=True),
                io.String.Input("user_prompt", default="Describe this image in detail.",
                                multiline=True, dynamic_prompts=True),
                io.Int.Input(
                    "context_window_size", default=8192, min=512, max=1048576,
                    step=512,
                    tooltip="Context window size in tokens. Larger values use more memory."),
                io.Int.Input("max_tokens", default=2048, min=1, max=32768),
                io.Float.Input("temperature", default=0.7, min=0.0, max=2.0, step=0.05),
                io.Int.Input("top_k", default=20, min=1, max=1000),
                io.Float.Input("top_p", default=0.8, min=0.0, max=1.0, step=0.01),
                io.Float.Input("min_p", default=0.05, min=0.0, max=1.0, step=0.01),
                io.Float.Input("repeat_penalty", default=1.0, min=0.0, max=3.0, step=0.01),
                io.Float.Input("presence_penalty", default=0.0, step=0.01),
                io.Int.Input("seed", default=1, min=-1, max=MAX_LLAMA_SEED),
                io.Combo.Input("reasoning", options=["auto", "on", "off"], default="off"),
                io.Autogrow.Input(
                    "images", optional=True, template=images,
                    tooltip="(needs GGUF model with vision support like Qwen or Gemma)"),
                io.Autogrow.Input(
                    "audios", optional=True, template=audios,
                    tooltip="(needs GGUF model with audio input support like Gemma4 12b)"),
                io.Combo.Input(
                    "flash_attention", options=list(FLASH_ATTENTION_OPTIONS),
                    default="auto",
                    tooltip="Select llama.cpp Flash Attention mode."),
                io.Combo.Input(
                    "kv_cache", options=list(KV_CACHE_OPTIONS),
                    default=KV_CACHE_OPTIONS[0],
                    tooltip="Set the K and V cache type for the main model and selected MTP model."),
                io.Int.Input("timeout_seconds", default=300, min=10, max=3600),
            ],
            outputs=[
                io.String.Output("response"),
                io.String.Output("reasoning"),
                io.String.Output(
                    "stats",
                    tooltip=(
                        "Shows total node runtime and llama.cpp generation-speed "
                        "statistics.")),
            ],
        )

    @classmethod
    def IS_CHANGED(cls, model, mmproj, mtp_model=NO_MTP_MODEL, **kwargs):
        paths = [full_model_path(model)]
        project = full_mmproj_path(mmproj)
        if project is not None:
            paths.append(project)
        mtp = full_mtp_model_path(mtp_model)
        if mtp is not None:
            paths.append(mtp)
        return tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths)

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
    ):
        started = time.perf_counter()
        comfy.model_management.unload_all_models()
        command, cleanup_paths = build_command(
            model_path=full_model_path(model),
            mmproj_path=full_mmproj_path(mmproj),
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
            mtp_model_path=full_mtp_model_path(mtp_model),
            flash_attention=flash_attention,
            kv_cache=kv_cache,
        )
        response, reasoning_text, perf = run_llama_cli(
            command=command,
            timeout_seconds=timeout_seconds,
            cleanup_paths=cleanup_paths,
        )
        elapsed = time.perf_counter() - started
        stats = f"Node generation time: {elapsed:.2f} s"
        if perf:
            stats += f"\n{perf}"
        return io.NodeOutput(response, reasoning_text, stats)
