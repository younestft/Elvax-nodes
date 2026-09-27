from __future__ import annotations

# Adapted from KingManiya/ComfyUI-LLM-text-processor (GPL-3.0).
# Modified for Elvax LLM Turbo on 2026-09-24.

import os
import re
import shlex
import subprocess
import tempfile
import time
import wave
from pathlib import Path

import comfy.model_management

from .llama_binary import ensure_llama_cli_paths


PROMPT_ECHO_END = "... (truncated)"
PROMPT_PADDING = " " * 501
PERF_RE = re.compile(r"\[\s*Prompt:\s*[^|\]]+\|\s*Generation:\s*[^\]]+\]")
MMPROJ_EMBEDDING_MISMATCH_RE = re.compile(
    r"mismatch between text model \(n_embd = (?P<model>\d+)\) and mmproj \(n_embd = (?P<mmproj>\d+)\)",
    flags=re.IGNORECASE,
)
START_THINKING = "[Start thinking]"
END_THINKING = "[End thinking]"
LLAMA_RANDOM_SEED = -1
LLAMA_SEED_MODULUS = 2**32
MAX_LLAMA_SEED = LLAMA_SEED_MODULUS - 1
FLASH_ATTENTION_OPTIONS = ("auto", "on", "off")
KV_CACHE_OPTIONS = (
    "F16 - Maximum quality",
    "Q8_0 - Recommended",
    "Q4_0 - Low VRAM",
    "IQ4_NL - Low VRAM / higher quality",
)
KV_CACHE_TYPES = {
    "F16 - Maximum quality": "f16",
    "Q8_0 - Recommended": "q8_0",
    "Q4_0 - Low VRAM": "q4_0",
    "IQ4_NL - Low VRAM / higher quality": "iq4_nl",
}

_UI_CONTROLLED_FLAGS = {
    "--flash-attn": "optional-value",
    "-fa": "optional-value",
    "--cache-type-k": "value",
    "-ctk": "value",
    "--cache-type-v": "value",
    "-ctv": "value",
}
_MTP_CONTROLLED_FLAGS = {
    "--model-draft": "value",
    "--spec-draft-model": "value",
    "-md": "value",
    "--spec-draft-hf": "value",
    "-hfd": "value",
    "-hfrd": "value",
    "--hf-repo-draft": "value",
    "--spec-type": "value",
    "--spec-draft-type-k": "value",
    "--cache-type-k-draft": "value",
    "-ctkd": "value",
    "--spec-draft-type-v": "value",
    "--cache-type-v-draft": "value",
    "-ctvd": "value",
}


def _tensor_to_temp_png(tensor) -> Path:
    import numpy as np
    from PIL import Image

    array = (tensor.detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    pil_image = Image.fromarray(array)
    fd, path = tempfile.mkstemp(prefix="llm-text-processor-", suffix=".png")
    os.close(fd)
    pil_image.save(path, format="PNG")
    return Path(path)


def tensor_to_temp_pngs(images) -> list[Path]:
    paths = []
    for image in _media_slot_values(images, "image"):
        # ComfyUI IMAGE is normally B,H,W,C. Each batch item becomes one CLI image.
        if hasattr(image, "dim") and image.dim() == 4:
            paths.extend(_tensor_to_temp_png(tensor) for tensor in image)
        else:
            paths.append(_tensor_to_temp_png(image))
    return paths


def _media_slot_values(inputs, prefix: str):
    if inputs is None:
        return []
    if not isinstance(inputs, dict) or "waveform" in inputs:
        return [inputs]
    return [
        inputs[name]
        for index in range(1, 10)
        if (name := f"{prefix}_{index}") in inputs and inputs[name] is not None
    ]


def audio_to_temp_wavs(audio) -> list[Path]:
    import numpy as np

    paths = []
    for audio_item in _media_slot_values(audio, "audio"):
        waveform = audio_item["waveform"]
        waveforms = list(waveform) if waveform.dim() == 3 else [waveform]
        sample_rate = int(audio_item["sample_rate"])
        for item in waveforms:
            samples = item.detach().cpu().float().numpy()
            if samples.ndim == 1:
                samples = samples[None, :]
            pcm = (samples.T.clip(-1.0, 1.0) * 32767).astype("<i2")
            fd, path = tempfile.mkstemp(prefix="llm-turbo-audio-", suffix=".wav")
            os.close(fd)
            wav_path = Path(path)
            with wave.open(str(wav_path), "wb") as output:
                output.setnchannels(samples.shape[0])
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(pcm.tobytes())
            paths.append(wav_path)
    return paths


def _write_temp_text_file(prefix: str, text: str) -> Path:
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=".txt")
    os.close(fd)
    text_path = Path(path)
    text_path.write_text(text, encoding="utf-8", newline="\n")
    return text_path


def _write_prompt_file(prompt: str) -> Path:
    return _write_temp_text_file("llm-text-processor-prompt-", prompt.strip() + PROMPT_PADDING)


def split_extra_args(extra_args: str) -> list[str]:
    if not extra_args or not extra_args.strip():
        return []
    parts = shlex.split(extra_args, posix=(os.name != "nt"))
    return [part.strip("\"'") for part in parts]


def filter_ui_controlled_args(args: list[str] | None, mtp_model_selected: bool) -> list[str]:
    if not args:
        return []

    filtered = []
    index = 0
    while index < len(args):
        arg = args[index]
        flag, separator, _ = arg.partition("=")
        flag = flag.lower().replace("_", "-")
        mode = _UI_CONTROLLED_FLAGS.get(flag)
        if mode is None and mtp_model_selected:
            mode = _MTP_CONTROLLED_FLAGS.get(flag)

        if mode is None:
            filtered.append(arg)
            index += 1
            continue

        index += 1
        if separator or index >= len(args):
            continue

        next_arg = args[index]
        if mode == "value" and not next_arg.startswith("-"):
            index += 1
        elif mode == "optional-value" and next_arg.lower() in FLASH_ATTENTION_OPTIONS:
            index += 1

    return filtered


def normalize_llama_seed(seed: int) -> int:
    seed = int(seed)
    if seed == LLAMA_RANDOM_SEED:
        return LLAMA_RANDOM_SEED
    if 0 <= seed <= MAX_LLAMA_SEED:
        return seed
    return seed % LLAMA_SEED_MODULUS


def build_command(
    model_path: Path,
    mmproj_path: Path | None,
    system_prompt: str,
    images,
    audio,
    user_prompt: str,
    max_tokens: int,
    temperature: float,
    top_p: float,
    top_k: int,
    repeat_penalty: float,
    context_window_size: int,
    seed: int,
    reasoning: str,
    extra_args: list[str] | None = None,
    mtp_model_path: Path | None = None,
    flash_attention: str = "auto",
    kv_cache: str = KV_CACHE_OPTIONS[0],
) -> tuple[list[str], tuple[Path | None, ...]]:
    if flash_attention not in FLASH_ATTENTION_OPTIONS:
        raise ValueError(f"Unsupported Flash Attention mode: {flash_attention}")
    if kv_cache not in KV_CACHE_TYPES:
        raise ValueError(f"Unsupported KV cache choice: {kv_cache}")

    kv_cache_type = KV_CACHE_TYPES[kv_cache]
    extra_args = filter_ui_controlled_args(extra_args, mtp_model_path is not None)
    cleanup_paths = []
    cli_paths = ensure_llama_cli_paths()
    image_paths = []
    audio_paths = []
    if images is not None or audio is not None:
        if mmproj_path is None:
            raise ValueError("Image and audio input require a selected multimodal mmproj GGUF file.")
    if images is not None:
        image_paths = tensor_to_temp_pngs(images)
        cleanup_paths.extend(image_paths)
    if audio is not None:
        audio_paths = audio_to_temp_wavs(audio)
        cleanup_paths.extend(audio_paths)
    prompt_path = _write_prompt_file(user_prompt)
    cleanup_paths.append(prompt_path)
    system_prompt_path = None
    if system_prompt.strip():
        system_prompt_path = _write_temp_text_file("llm-turbo-system-", system_prompt)
        cleanup_paths.append(system_prompt_path)

    command = [
        str(cli_paths.cli),
        "-m", str(model_path),
        "-n", str(max_tokens),
        "--temp", str(temperature),
        "--top-p", str(top_p),
        "--top-k", str(top_k),
        "--repeat-penalty", str(repeat_penalty),
        "-c", str(context_window_size),
        "--seed", str(normalize_llama_seed(seed)),
        "--single-turn",
        "--reasoning", reasoning,
    ]

    if system_prompt_path is not None:
        command.extend(["-sysf", str(system_prompt_path)])

    command.extend(["-f", str(prompt_path)])

    if image_paths or audio_paths:
        command.extend(["--mmproj", str(mmproj_path)])
    if image_paths:
        command.extend(["--image", ",".join(str(path) for path in image_paths)])
    if audio_paths:
        command.extend(["--audio", ",".join(str(path) for path in audio_paths)])
    if extra_args:
        command.extend(extra_args)
    command.extend(["--flash-attn", flash_attention])
    command.extend(["--cache-type-k", kv_cache_type, "--cache-type-v", kv_cache_type])
    if mtp_model_path is not None:
        command.extend([
            "--model-draft", str(mtp_model_path),
            "--spec-type", "draft-mtp",
            "--spec-draft-type-k", kv_cache_type,
            "--spec-draft-type-v", kv_cache_type,
        ])

    # LLM Turbo starts a fresh llama-cli process for every run, so prompt
    # context checkpoints cannot be reused across runs. Disable them; this
    # also avoids excess checkpoint memory use reported with Gemma 4.
    command.extend(["--ctx-checkpoints", "0"])
    return command, tuple(cleanup_paths)


def run_llama_cli(
    command: list[str],
    timeout_seconds: int,
    cleanup_paths: tuple[Path | None, ...] = (),
) -> tuple[str, str, str]:
    process = None
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
        stdout, stderr = _communicate_with_interrupt(process, timeout_seconds)
        result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except BaseException:
        if process is not None:
            _stop_process(process)
        raise
    finally:
        # Temp prompt/image files can be large in workflows that run many times,
        # so cleanup happens even when llama.cpp exits with an error.
        for path in cleanup_paths:
            if path and path.exists():
                path.unlink()

    if result.returncode != 0:
        stderr = result.stderr.strip()
        message = _parse_llama_error(stderr)
        if message:
            raise RuntimeError(message)
        raise RuntimeError(
            f"llama.cpp inference failed with exit code {result.returncode}:\n{stderr}"
        )
    return _parse_response(result.stdout + "\n" + result.stderr)


def _stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _communicate_with_interrupt(process: subprocess.Popen, timeout_seconds: int) -> tuple[str, str]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        if comfy.model_management.processing_interrupted():
            _stop_process(process)
            # Reset the global interrupt flag and raise the exact exception
            # ComfyUI expects so the UI reports this as an interruption.
            comfy.model_management.throw_exception_if_processing_interrupted()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _stop_process(process)
            raise TimeoutError(f"llama.cpp timed out after {timeout_seconds}s")
        try:
            return process.communicate(timeout=min(0.1, remaining))
        except subprocess.TimeoutExpired:
            continue


def _parse_response(text: str) -> tuple[str, str, str]:
    text = str(text or "")
    if PROMPT_ECHO_END in text:
        text = text.split(PROMPT_ECHO_END, 1)[1]

    perf_match = PERF_RE.search(text)
    perf = perf_match.group(0).strip() if perf_match else ""
    content = text[:perf_match.start()] if perf_match else text
    content = content.strip()
    if not content.startswith(START_THINKING):
        return content, "", perf

    thinking_text = content[len(START_THINKING):]
    if END_THINKING not in thinking_text:
        return "", thinking_text.strip(), perf

    thinking, response = thinking_text.split(END_THINKING, 1)
    return response.strip(), thinking.strip(), perf


def _parse_llama_error(stderr: str) -> str:
    match = MMPROJ_EMBEDDING_MISMATCH_RE.search(str(stderr or ""))
    if not match:
        return ""
    return (
        "Selected mmproj does not match the text model "
        f"(model n_embd={match.group('model')}, mmproj n_embd={match.group('mmproj')}). "
        "Choose the mmproj file that belongs to the selected GGUF model."
    )
