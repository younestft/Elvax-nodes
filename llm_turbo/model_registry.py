from __future__ import annotations

# Adapted from KingManiya/ComfyUI-LLM-text-processor (GPL-3.0).
# Modified for Elvax LLM Turbo on 2026-09-24.

from pathlib import Path

import folder_paths


NO_MODELS_FOUND = "No GGUF models found"
NO_MMPROJ = "none"


def _model_roots() -> list[tuple[str, Path]]:
    roots = [("LLM", Path(folder_paths.models_dir) / "LLM")]

    for path in folder_paths.folder_names_and_paths.get("LLM", ([], set()))[0]:
        roots.append(("LLM", Path(path)))

    for path in folder_paths.folder_names_and_paths.get("text_encoders", ([], set()))[0]:
        encoder_root = Path(path)
        roots.append(("LLM", encoder_root.parent / "LLM"))
        roots.append(("text_encoders", encoder_root))

    seen = set()
    unique = []
    for source, root in roots:
        resolved = root.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append((source, root))
    return unique


def gguf_paths() -> dict[str, Path]:
    found: dict[str, Path] = {}
    seen_files = set()
    for source, root in _model_roots():
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix.lower() != ".gguf":
                continue
            resolved = path.resolve()
            if resolved in seen_files:
                continue
            seen_files.add(resolved)
            name = f"{source}/{path.relative_to(root).as_posix()}"
            if name in found:
                name = f"{name} [{root}]"
            found[name] = resolved
    return found


def model_options() -> list[str]:
    models = [name for name in gguf_paths() if "mmproj" not in Path(name).name.lower()]
    return sorted(models, key=str.casefold) or [NO_MODELS_FOUND]


def mmproj_options() -> list[str]:
    projects = [name for name in gguf_paths() if "mmproj" in Path(name).name.lower()]
    return [NO_MMPROJ] + sorted(projects, key=str.casefold)


def full_model_path(name: str) -> Path:
    if name == NO_MODELS_FOUND:
        raise FileNotFoundError("No GGUF model found in the configured LLM or text_encoders folders.")
    path = gguf_paths().get(name)
    if path is None or "mmproj" in path.name.lower():
        raise FileNotFoundError(f"GGUF model not found: {name}")
    return path


def full_mmproj_path(name: str) -> Path | None:
    if name == NO_MMPROJ:
        return None
    path = gguf_paths().get(name)
    if path is None or "mmproj" not in path.name.lower():
        raise FileNotFoundError(f"mmproj GGUF not found: {name}")
    return path
