from __future__ import annotations

# Adapted from KingManiya/ComfyUI-LLM-text-processor (GPL-3.0).
# Modified for Elvax LLM Turbo on 2026-09-24.

import time

from .llama_cli import MAX_LLAMA_SEED, build_command, run_llama_cli, split_extra_args
from .model_registry import (
    NO_MMPROJ,
    full_mmproj_path,
    full_model_path,
    mmproj_options,
    model_options,
)


class LLMTurbo:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (model_options(), {"tooltip": "GGUF model from configured LLM or text_encoders folders."}),
                "mmproj": (mmproj_options(), {"default": NO_MMPROJ, "tooltip": "Matching vision projector GGUF for image input."}),
                "system_prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True}),
                "user_prompt": ("STRING", {"default": "Describe this image in detail.", "multiline": True, "dynamicPrompts": True}),
                "context_window_size": ("INT", {"default": 8192, "min": 512, "max": 1048576, "step": 512,
                                               "tooltip": "Context window size in tokens. Larger values use more memory."}),
                "max_tokens": ("INT", {"default": 2048, "min": 1, "max": 32768}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05}),
                "top_p": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 20, "min": 1, "max": 1000}),
                "repeat_penalty": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 3.0, "step": 0.01}),
                "seed": ("INT", {"default": 1, "min": -1, "max": MAX_LLAMA_SEED}),
                "timeout_seconds": ("INT", {"default": 300, "min": 10, "max": 3600}),
                "reasoning": (["auto", "on", "off"], {"default": "off"}),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "One image or a ComfyUI image batch."}),
                "extra_args": ("STRING", {"default": "", "multiline": False,
                                          "tooltip": "Additional llama.cpp options. Leave empty for normal use."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("response", "reasoning", "stats")
    FUNCTION = "generate"
    CATEGORY = "Elvax"
    TITLE = "LLM Turbo"

    @classmethod
    def VALIDATE_INPUTS(cls, model, mmproj):
        return True

    @classmethod
    def IS_CHANGED(cls, model, mmproj, **kwargs):
        paths = [full_model_path(model)]
        project = full_mmproj_path(mmproj)
        if project is not None:
            paths.append(project)
        return tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths)

    def generate(
        self,
        model: str,
        mmproj: str,
        system_prompt: str,
        user_prompt: str,
        context_window_size: int,
        max_tokens: int,
        temperature: float,
        top_p: float,
        top_k: int,
        repeat_penalty: float,
        seed: int,
        timeout_seconds: int,
        reasoning: str,
        images=None,
        extra_args: str = "",
    ):
        started = time.perf_counter()
        command, cleanup_paths = build_command(
            model_path=full_model_path(model),
            mmproj_path=full_mmproj_path(mmproj),
            system_prompt=system_prompt,
            images=images,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repeat_penalty=repeat_penalty,
            context_window_size=context_window_size,
            seed=seed,
            reasoning=reasoning,
            extra_args=split_extra_args(extra_args),
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
        return (response, reasoning_text, stats)
