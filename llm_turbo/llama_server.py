import atexit
import base64
import json
import os
import platform
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import comfy.model_management

from .llama_cli import _stop_process
from .process_job import attach_job, close_job
from .llama_binary import binary_environment, clear_binary_cache, _binary_signature


def _format_stats(result, mtp_enabled=False):
    timings = result.get("timings") or {}
    lines = []
    for key, label in (("prompt_per_second", "Prompt speed"), ("predicted_per_second", "Generation speed")):
        if timings.get(key) is not None:
            lines.append(f"{label}: {timings[key]:.2f} tokens/s")
    count = (result.get("timings") or {}).get("predicted_n")
    if count is None:
        count = (result.get("usage") or {}).get("completion_tokens")
    drafted, accepted = timings.get("draft_n"), timings.get("draft_n_accepted")
    if mtp_enabled and drafted and accepted is not None:
        lines.append(f"MTP acceptance: {100 * accepted / drafted:.0f}%")
    if lines:
        lines.append("")
    usage = result.get("usage") or {}
    context = usage.get("total_tokens")
    if context is None and usage.get("prompt_tokens") is not None and usage.get("completion_tokens") is not None:
        context = usage["prompt_tokens"] + usage["completion_tokens"]
    if context is None and all(timings.get(key) is not None for key in ("cache_n", "prompt_n", "predicted_n")):
        context = timings["cache_n"] + timings["prompt_n"] + timings["predicted_n"]
    lines.append(f"Context usage: {context} tokens" if context is not None else "Context usage: unavailable")
    lines.append(f"Generated tokens: {count}" if count is not None else "Generated tokens: unavailable")
    if timings.get("cache_n") is not None:
        lines.append(f"Reused input tokens: {timings['cache_n']}")
    return "\n".join(lines)


class ManagedServer:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.job = None
        self.key = None
        self.log = None
        self.url = None
        self.api_key = secrets.token_urlsafe(32)
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def stop(self):
        with self.lock:
            if self.process is not None:
                _stop_process(self.process)
                self.process = None
            if self.log is not None:
                self.log.close()
                self.log = None
            close_job(self.job)
            self.job = None
            self.key = None

    def check(self, deadline):
        comfy.model_management.throw_exception_if_processing_interrupted()
        if time.monotonic() >= deadline:
            raise TimeoutError("LLM Turbo timed out.")
        if self.process.poll() is not None:
            self.log.seek(0)
            raise RuntimeError("llama-server stopped:\n" + self.log.read().decode("utf-8", errors="replace")[-4000:])

    def request(self, command, timeout_seconds):
        args = [x for x in command[1:] if x != "--single-turn"]
        flags = dict(zip(args[::2], args[1::2]))
        sampling = {"-n": "max_tokens", "--temp": "temperature", "--top-p": "top_p", "--min-p": "min_p",
                    "--top-k": "top_k", "--repeat-penalty": "repeat_penalty", "--presence-penalty": "presence_penalty", "--seed": "seed"}
        body = {target: int(flags[key]) if key in ("-n", "--top-k", "--seed") else float(flags[key]) for key, target in sampling.items()}
        content = [{"type": "text", "text": Path(flags["-f"]).read_text(encoding="utf-8")}]
        for flag, kind, mime in (("--image", "image_url", "image/png"), ("--audio", "input_audio", "audio/wav")):
            for filename in flags.get(flag, "").split(","):
                if filename:
                    encoded = base64.b64encode(Path(filename).read_bytes()).decode("ascii")
                    content.append({"type": kind, kind: {"url": f"data:{mime};base64,{encoded}"} if kind == "image_url" else {"data": encoded, "format": "wav"}})
        messages = []
        if "-sysf" in flags:
            messages.append({"role": "system", "content": Path(flags["-sysf"]).read_text(encoding="utf-8")})
        messages.append({"role": "user", "content": content})
        body.update(messages=messages, stream=False, cache_prompt=True)
        reasoning = flags.get("--reasoning", "auto")
        if reasoning != "auto":
            body["chat_template_kwargs"] = {"enable_thinking": reasoning == "on"}
        excluded = set(sampling) | {"-f", "-sysf", "--image", "--audio", "--reasoning", "--ctx-checkpoints"}
        load_args = [value for key, value in flags.items() if key not in excluded for value in (key, value)]
        load_args += ["--jinja", "--reasoning-format", "deepseek", "--parallel", "1"]
        files = [command[0]] + [flags[k] for k in ("-m", "--mmproj", "--model-draft") if k in flags]
        key = (tuple(load_args), tuple((p, Path(p).stat().st_mtime_ns, Path(p).stat().st_size) for p in files), _binary_signature(Path(command[0])))
        with self.lock:
            deadline = time.monotonic() + timeout_seconds
            try:
                if self.key != key or self.process is None or self.process.poll() is not None:
                    self.stop()
                    with socket.socket() as sock:
                        sock.bind(("127.0.0.1", 0))
                        port = sock.getsockname()[1]
                    self.url = f"http://127.0.0.1:{port}"
                    self.log = tempfile.TemporaryFile()
                    self.process = subprocess.Popen([command[0], *load_args, "--host", "127.0.0.1", "--port", str(port), "--api-key", self.api_key, "--no-webui"],
                        stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log, cwd=Path(command[0]).parent,
                        env=binary_environment(Path(command[0])),
                        start_new_session=os.name != "nt",
                        creationflags=subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0)
                    if platform.system() == "Windows":
                        self.job = attach_job(self.process)
                    while True:
                        self.check(deadline)
                        try:
                            with self.http.open(self.url + "/health", timeout=1) as response:
                                if response.status == 200:
                                    break
                        except (urllib.error.URLError, TimeoutError):
                            pass
                        time.sleep(0.1)
                    self.key = key
                request = urllib.request.Request(self.url + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key})
                def send():
                    try:
                        with self.http.open(request, timeout=max(1, deadline - time.monotonic())) as response:
                            return json.load(response)
                    except urllib.error.HTTPError as exc:
                        raise RuntimeError("llama-server rejected the request: " + exc.read().decode("utf-8", errors="replace")[:2000]) from exc
                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(send)
                    try:
                        while not future.done():
                            self.check(deadline)
                            time.sleep(0.1)
                        result = future.result()
                    except BaseException:
                        self.stop()
                        raise
                message = result["choices"][0]["message"]
                return message.get("content") or "", message.get("reasoning_content") or "", _format_stats(result, "--model-draft" in flags)
            except BaseException:
                clear_binary_cache()
                self.stop()
                raise


server = ManagedServer()
atexit.register(server.stop)
