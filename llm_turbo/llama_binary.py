from __future__ import annotations

# Adapted from KingManiya/ComfyUI-LLM-text-processor (GPL-3.0).
# Modified for Elvax LLM Turbo on 2026-09-24.

import fnmatch
import json
import os
import platform
import re
import subprocess
import shutil
import tarfile
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import comfy.model_management
import torch


LLAMA_CPP_RELEASE_TAG = "b11960"
RELEASE_API_URL = f"https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{LLAMA_CPP_RELEASE_TAG}"
PACKAGE_ROOT = Path(__file__).resolve().parent
VENDOR_ROOT = PACKAGE_ROOT / "vendor" / "llama.cpp"
CUSTOM_ROOT = PACKAGE_ROOT / "custom_builds"
CUSTOM_ROOT.mkdir(exist_ok=True)
NO_CUSTOM_BUILD = "No custom builds found"
_RESOLVED_BUILDS = {}


def clear_binary_cache():
    _RESOLVED_BUILDS.clear()


def _binary_signature(executable):
    folders = (executable.parent, executable.parent / "lib", executable.parent.parent / "lib")
    files = {executable}
    for folder in folders:
        if folder.is_dir():
            files.update(p for p in folder.iterdir() if p.is_file() and (p.suffix.lower() in (".dll", ".dylib") or ".so" in p.name))
    file_info = tuple(sorted((str(p), p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_mode) for p in files))
    env = tuple(os.environ.get(k, "") for k in ("PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "GGML_VK_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES"))
    return file_info, env


def _remember_build(key, executable):
    if len(_RESOLVED_BUILDS) >= 16:
        _RESOLVED_BUILDS.pop(next(iter(_RESOLVED_BUILDS)))
    _RESOLVED_BUILDS[key] = (executable, _binary_signature(executable))
    return executable


def custom_build_options():
    return sorted(p.name for p in CUSTOM_ROOT.iterdir() if p.is_dir() and p.resolve().is_relative_to(CUSTOM_ROOT.resolve())) or [NO_CUSTOM_BUILD]


def backend_options():
    return {
        "Windows": ["Auto", "CUDA", "Vulkan", "Custom"] if platform.machine().lower() in {"arm64", "aarch64"} else ["Auto", "CUDA", "Vulkan", "ROCm", "Custom"],
        "Linux": ["Auto", "CUDA", "Vulkan", "ROCm", "Custom"] if platform.machine().lower() in {"amd64", "x86_64"} else ["Auto", "CUDA", "Vulkan", "Custom"],
        "Darwin": ["Metal", "Custom"],
    }.get(platform.system(), ["Custom"])


def binary_environment(executable):
    env = os.environ.copy()
    if platform.system() != "Windows":
        folders = [executable.parent, executable.parent / "lib", executable.parent.parent / "lib"]
        key = "DYLD_LIBRARY_PATH" if platform.system() == "Darwin" else "LD_LIBRARY_PATH"
        env[key] = os.pathsep.join([str(p) for p in folders if p.is_dir()] + ([env[key]] if env.get(key) else []))
    return env


def _auto_backends():
    if platform.system() == "Darwin":
        return ["Metal"]
    device = comfy.model_management.get_torch_device()
    names = torch.cuda.get_device_name(device).lower() if device.type == "cuda" else ""
    if not names and platform.system() == "Windows":
        probe = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
                               capture_output=True, text=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
        names = probe.stdout.lower()
    if not names and platform.system() == "Linux":
        vendors = {p.read_text().strip().lower() for p in Path("/sys/class/drm").glob("card*/device/vendor")}
        names = "nvidia" if "0x10de" in vendors else "amd" if "0x1002" in vendors else "intel" if "0x8086" in vendors else ""
    choices = ["CUDA", "Vulkan"] if "nvidia" in names else ["ROCm", "Vulkan"] if any(x in names for x in ("amd", "radeon")) else ["Vulkan"] if any(x in names for x in ("intel", "qualcomm", "adreno", "snapdragon")) else []
    return [choice for choice in choices if choice in backend_options()]


def _verify_gpu(executable, backend):
    result = subprocess.run([str(executable), "--list-devices"], capture_output=True, text=True,
                            errors="replace", timeout=30, cwd=executable.parent, env=binary_environment(executable),
                            creationflags=subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0)
    text = result.stdout + result.stderr
    prefix = {"CUDA": "CUDA", "ROCm": "(?:ROCm|HIP)", "Vulkan": "Vulkan", "Metal": "Metal"}[backend]
    if result.returncode or not re.search(r"^\s*" + prefix + r"\d*\s*:", text, re.MULTILINE | re.IGNORECASE):
        status = f" Exit code: {result.returncode}." if result.returncode else ""
        raise RuntimeError(f"{backend} could not initialize a GPU.{status} Check the build's libraries and GPU drivers, or select another backend.\n{text[-2000:]}")


def resolve_binary(backend=None, custom_build=NO_CUSTOM_BUILD, server=False):
    if backend is None:
        backend = backend_options()[0]
    name = "llama-server" if server else "llama-cli"
    name += ".exe" if platform.system() == "Windows" else ""
    if backend == "Custom":
        root = CUSTOM_ROOT.resolve()
        directory = (root / custom_build).resolve()
        if custom_build == NO_CUSTOM_BUILD or directory.parent != root or not directory.is_dir():
            raise ValueError("Select a custom build from ComfyUI/custom_nodes/Elvax-nodes/llm_turbo/custom_builds/.")
        executable = directory / name
        if not executable.is_file() or not executable.resolve().is_relative_to(root):
            raise ValueError(f"Custom build requires {name} directly inside its folder.")
        if platform.system() != "Windows" and not os.access(executable, os.X_OK):
            raise ValueError(f"{name} is not executable. Set its executable permission in the custom build folder.")
        return executable
    if backend not in backend_options():
        raise ValueError(f"Unsupported backend: {backend}")
    key = (platform.system(), platform.machine(), LLAMA_CPP_RELEASE_TAG, backend, server)
    cached = _RESOLVED_BUILDS.get(key)
    if cached is not None:
        executable, signature = cached
        try:
            if _binary_signature(executable) == signature:
                return executable
        except OSError:
            pass
        del _RESOLVED_BUILDS[key]
    if backend == "Auto":
        choices = _auto_backends()
        failures = []
        for choice in choices:
            try:
                return _remember_build(key, resolve_binary(choice, server=server))
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
                failures.append(str(exc))
                print(f"[LLM Turbo] {choice} unavailable: {exc}")
        raise RuntimeError("Auto could not find a working GPU backend. Use Custom for a CPU-only build.\n" + "\n".join(failures))
    spec = _platform_spec(backend)
    paths = ensure_llama_cli_paths(spec)
    executable = paths.cli.with_name(name)
    if not executable.is_file():
        raise RuntimeError(f"This llama.cpp package does not contain {name}.")
    _verify_gpu(executable, backend)
    print(f"[LLM Turbo] Backend: {backend}, llama.cpp {LLAMA_CPP_RELEASE_TAG}, executable: {executable}")
    return _remember_build(key, executable)


@dataclass(frozen=True)
class PlatformSpec:
    key: str
    cli_executable: str
    asset_patterns: tuple[str, ...]
    required_files: tuple[str, ...]


@dataclass(frozen=True)
class LlamaCliPaths:
    cli: Path


WINDOWS_CUDA_13 = PlatformSpec(
    key="win-x64-cuda13",
    cli_executable="llama-cli.exe",
    asset_patterns=(
        "llama-*-bin-win-cuda-13*-x64.zip",
        "cudart-llama-bin-win-cuda-13*-x64.zip",
    ),
    required_files=(
        "llama-cli.exe",
        "ggml-cuda.dll",
        "cudart64_13.dll",
    ),
)


def _platform_spec(backend=None) -> PlatformSpec:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine)
    if system == "windows" and arch:
        if backend in (None, "CUDA"):
            if arch == "x64":
                return WINDOWS_CUDA_13
            return PlatformSpec("win-arm64-cuda13", "llama-cli.exe",
                                ("llama-*-bin-win-cuda-13*-arm64.zip", "cudart-llama-bin-win-cuda-13*-arm64.zip"),
                                ("llama-cli.exe", "llama-server.exe", "ggml-cuda.dll", "cudart64_13.dll"))
        if backend == "Vulkan" or (backend == "ROCm" and arch == "x64"):
            token = "vulkan" if backend == "Vulkan" else "rocm*"
            return PlatformSpec(f"win-{arch}-{backend.lower()}", "llama-cli.exe",
                                (f"llama-*-bin-win-{token}-{arch}.zip",), ("llama-cli.exe", "llama-server.exe"))
    if system == "linux" and arch and backend == "CUDA":
        version = "12.8" if arch == "x64" else "13.4"
        return PlatformSpec(f"linux-{arch}-cuda{version}", "llama-cli",
                            (f"llama-*-bin-ubuntu-cuda-{version}-{arch}.tar.gz",
                             f"cudart-llama-*-bin-ubuntu-cuda-{version}-{arch}.tar.gz"),
                            ("llama-cli", "llama-server", "libggml-cuda.so*", "libcudart.so*", "libcublas.so*", "libcublasLt.so*"))
    if system == "linux" and arch == "x64" and backend == "ROCm":
        return PlatformSpec("linux-x64-rocm10", "llama-cli",
                            ("llama-*-bin-ubuntu-rocm-10.0-x64.tar.gz",),
                            ("llama-cli", "llama-server", "libggml-hip.so*"))
    if system == "linux" and arch and backend in (None, "Vulkan"):
        return PlatformSpec(f"linux-{arch}-vulkan", "llama-cli",
                            (f"llama-*-bin-ubuntu-vulkan-{arch}.tar.gz",), ("llama-cli", "llama-server"))
    if system == "darwin" and arch and backend in (None, "Metal"):
        return PlatformSpec(f"macos-{arch}-metal", "llama-cli",
                            (f"llama-*-bin-macos-{arch}.tar.gz",), ("llama-cli", "llama-server"))
    raise RuntimeError(
        f"No supported llama.cpp package for {system}/{machine}/{backend}. Select Custom and provide a compatible build."
    )


def _json_get(url: str) -> dict:
    comfy.model_management.throw_exception_if_processing_interrupted()
    request = urllib.request.Request(url, headers={"User-Agent": "Elvax-LLM-Turbo"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _format_size(num_bytes: float) -> str:
    units = ("B", "KB", "MB", "GB")
    value = float(num_bytes)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def _download(url: str, destination: Path) -> None:
    comfy.model_management.throw_exception_if_processing_interrupted()
    request = urllib.request.Request(url, headers={"User-Agent": "Elvax-LLM-Turbo"})
    with urllib.request.urlopen(request, timeout=120) as response:
        total_size = response.headers.get("Content-Length")
        total_size = int(total_size) if total_size is not None else None
        downloaded = 0
        chunk_size = 1024 * 256
        started_at = time.monotonic()
        last_reported_at = started_at

        with destination.open("wb") as handle:
            while True:
                comfy.model_management.throw_exception_if_processing_interrupted()
                chunk = response.read1(chunk_size)
                comfy.model_management.throw_exception_if_processing_interrupted()
                if not chunk:
                    break
                handle.write(chunk)
                downloaded += len(chunk)

                now = time.monotonic()
                if now - last_reported_at < 1.0:
                    continue

                elapsed = max(now - started_at, 0.001)
                speed = downloaded / elapsed
                if total_size:
                    percent = (downloaded / total_size) * 100
                    print(
                        "[LLM Turbo] "
                        f"Downloaded {_format_size(downloaded)} / {_format_size(total_size)} "
                        f"({percent:.1f}%) at {_format_size(speed)}/s"
                    )
                else:
                    print(
                        "[LLM Turbo] "
                        f"Downloaded {_format_size(downloaded)} at {_format_size(speed)}/s"
                    )
                last_reported_at = now

        elapsed = max(time.monotonic() - started_at, 0.001)
        speed = downloaded / elapsed
        if total_size:
            print(
                "[LLM Turbo] "
                f"Finished download: {_format_size(downloaded)} / {_format_size(total_size)} "
                f"(100.0%) at {_format_size(speed)}/s"
            )
        else:
            print(
                "[LLM Turbo] "
                f"Finished download: {_format_size(downloaded)} at {_format_size(speed)}/s"
            )


def _select_assets(release: dict, spec: PlatformSpec) -> list[dict]:
    assets = release.get("assets", [])
    selected = []
    used_names = set()

    # Match explicit release asset names so a future platform can add patterns
    # without changing the download/extract pipeline.
    for pattern in spec.asset_patterns:
        matches = [
            asset for asset in assets
            if fnmatch.fnmatch(asset.get("name", "").lower(), pattern.lower())
        ]
        if not matches:
            raise RuntimeError(f"Could not find llama.cpp release asset matching: {pattern}")
        asset = sorted(matches, key=lambda item: item.get("name", ""))[0]
        if asset["name"] not in used_names:
            selected.append(asset)
            used_names.add(asset["name"])
    return selected


def _find_file(install_dir: Path, name: str) -> Path | None:
    for path in install_dir.rglob(name):
        if path.is_file():
            return path
    return None


def _find_cli_paths(install_dir: Path, spec: PlatformSpec) -> LlamaCliPaths | None:
    cli = _find_file(install_dir, spec.cli_executable)
    if cli is None:
        return None
    return LlamaCliPaths(cli=cli)


def _has_required_files(install_dir: Path, spec: PlatformSpec) -> bool:
    for name in spec.required_files:
        if not any(path.is_file() for path in install_dir.rglob(name)):
            return False
    return True


def _is_complete_install(install_dir: Path, spec: PlatformSpec) -> bool:
    manifest = install_dir / "installation_files.json"
    if manifest.is_file():
        try:
            files = json.loads(manifest.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return False
        if not isinstance(files, list) or not files:
            return False
        root = install_dir.resolve()
        for name in files:
            if not isinstance(name, str):
                return False
            path = (root / name).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                return False
    return _find_cli_paths(install_dir, spec) is not None and _has_required_files(install_dir, spec)


def _existing_install(spec: PlatformSpec) -> LlamaCliPaths | None:
    install_dir = VENDOR_ROOT / LLAMA_CPP_RELEASE_TAG / spec.key
    return _find_cli_paths(install_dir, spec) if _is_complete_install(install_dir, spec) else None


def _extract_assets(assets: list[dict], install_dir: Path, spec: PlatformSpec) -> None:
    with TemporaryDirectory(prefix="llm-text-processor-llama-download-") as temp:
        temp_dir = Path(temp)
        staging = install_dir.with_name(install_dir.name + ".staging")
        if not staging.resolve().is_relative_to(VENDOR_ROOT.resolve()):
            raise ValueError("Invalid llama.cpp installation folder")
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        try:
            for asset in assets:
                comfy.model_management.throw_exception_if_processing_interrupted()
                archive_path = temp_dir / asset["name"]
                print(f"[LLM Turbo] Downloading {asset['name']}...")
                _download(asset["browser_download_url"], archive_path)
                root = staging.resolve()
                if asset["name"].endswith(".zip"):
                    with zipfile.ZipFile(archive_path) as archive:
                        if any(not (root / member.filename).resolve().is_relative_to(root) for member in archive.infolist()):
                            raise ValueError("Unsafe path in llama.cpp archive")
                        archive.extractall(staging)
                else:
                    with tarfile.open(archive_path, "r:gz") as archive:
                        archive.extractall(staging, filter="data")
                    if asset["name"].startswith("cudart-"):
                        executable = _find_file(staging, spec.cli_executable)
                        if executable is None:
                            raise RuntimeError("Install the llama.cpp executable before its CUDA runtime package.")
                        runtime_dir = staging / asset["name"][:-7]
                        for library in runtime_dir.iterdir():
                            if library.is_file() or library.is_symlink():
                                shutil.move(str(library), executable.parent / library.name)
            comfy.model_management.throw_exception_if_processing_interrupted()
            if not _is_complete_install(staging, spec):
                missing = [name for name in spec.required_files if not any(p.is_file() for p in staging.rglob(name))]
                raise RuntimeError("Downloaded llama.cpp package is incomplete; missing: " + ", ".join(missing))
            files = sorted(p.relative_to(staging).as_posix() for p in staging.rglob("*") if p.is_file())
            (staging / "installation_files.json").write_text(json.dumps(files), encoding="utf-8")
            if not install_dir.resolve().is_relative_to(VENDOR_ROOT.resolve()):
                raise ValueError("Invalid llama.cpp installation folder")
            if install_dir.exists():
                shutil.rmtree(install_dir)
            os.replace(staging, install_dir)
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def ensure_llama_cli_paths(spec=None) -> LlamaCliPaths:
    spec = spec or _platform_spec()
    existing = _existing_install(spec)
    if existing is not None:
        return existing

    sibling_install = (
        PACKAGE_ROOT.parent.parent
        / "ComfyUI-LLM-text-processor"
        / "vendor"
        / "llama.cpp"
        / LLAMA_CPP_RELEASE_TAG
        / spec.key
    )
    if _is_complete_install(sibling_install, spec):
        paths = _find_cli_paths(sibling_install, spec)
        if paths is not None:
            return paths

    release = _json_get(RELEASE_API_URL)
    tag = release.get("tag_name") or LLAMA_CPP_RELEASE_TAG
    install_dir = VENDOR_ROOT / tag / spec.key

    if _is_complete_install(install_dir, spec):
        paths = _find_cli_paths(install_dir, spec)
        if paths is None:
            raise RuntimeError(f"Completed install has incomplete CLI executables: {install_dir}")
        return paths

    assets = _select_assets(release, spec)
    install_dir.mkdir(parents=True, exist_ok=True)
    _extract_assets(assets, install_dir, spec)

    paths = _find_cli_paths(install_dir, spec)
    if paths is None:
        raise RuntimeError(
            f"Downloaded llama.cpp assets but could not find CLI executables in {install_dir}"
        )
    if not _has_required_files(install_dir, spec):
        missing = [
            name for name in spec.required_files
            if not any(path.is_file() for path in install_dir.rglob(name))
        ]
        raise RuntimeError(f"Downloaded llama.cpp assets are incomplete; missing: {', '.join(missing)}")

    return paths
