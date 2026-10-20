import gc
import os
import queue
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from fractions import Fraction

import av
from av.video.reformatter import VideoReformatter
import comfy.model_management
import comfy.utils
import torch
from comfy_api.latest import InputImpl, Types
from comfy_api.latest._input_impl.video_types import BT709_NCL, set_video_color_properties, video_encoder_options
from server import PromptServer


class PostProcessing:
    _workflow_started = None
    SEARCH_ALIASES = ["elvax", "turbo", "turbo post processing", "upscale", "upscale video", "interpolate", "interpolate video", "grain", "film grain", "rife"]
    _UPSCALE_WORKERS = 6
    _GROUP_MODES = ("full sequence", "normal (64)", "low vram (16)", "custom")
    _ENCODER_PRESETS = ("ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow")
    _H264_PROFILES = ("auto", "baseline", "main", "high")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "upscale": ("BOOLEAN", {"default": True}),
                "upscale_method": (["lanczos"], {"default": "lanczos"}),
                "upscale_by": ("FLOAT", {"default": 2.0, "min": 0.01, "max": 8.0, "step": 0.01}),
                "interpolate": ("BOOLEAN", {"default": True}),
                "original_fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.1}),
                "interpolate_by": ("INT", {"default": 2, "min": 2, "max": 10, "step": 1}),
                "dual_pass_rife": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Runs RIFE in both directions and combines the results. May improve interpolation quality, but takes longer and uses more VRAM.",
                }),
                "grain": ("BOOLEAN", {"default": True}),
                "grain_intensity": ("FLOAT", {"default": 0.025, "min": 0.001, "max": 1.0, "step": 0.001}),
                "saturation_mix": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "compress": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Compresses the finished video to reduce file size. Disable for lossless encoding.",
                }),
                "crf": ("INT", {
                    "default": 18, "min": 0, "max": 51, "step": 1,
                    "tooltip": "Lower values preserve more detail and produce larger files.",
                }),
                "batching_mode": (list(cls._GROUP_MODES), {
                    "default": "normal (64)",
                    "tooltip": "Frames processed at a time. Smaller batches use less memory but may be slower.",
                }),
                "custom_batch_size": ("INT", {
                    "default": 16, "min": 1, "max": 2147483647, "step": 1,
                    "tooltip": "Used only when batching_mode is custom.",
                }),
                "encoder_preset": (list(cls._ENCODER_PRESETS), {
                    "default": "ultrafast",
                    "tooltip": "H.264 encoding speed versus compression efficiency. Slower presets take longer but generally produce smaller files at the same CRF.",
                }),
                "h264_profile": (list(cls._H264_PROFILES), {
                    "default": "auto",
                    "tooltip": "H.264 profile constraints. Auto preserves the encoder's current behavior. The actual profile may be lower if the preset disables higher-profile features. Forced profiles require compression enabled and CRF above 0.",
                }),
            },
            "optional": {
                "video": ("VIDEO", {"tooltip": "Optional video source. When connected, its frames and frame rate are used instead of images."}),
                "images": ("IMAGE", {"tooltip": "Image batch used when no video is connected."}),
                "audio_pass": ("AUDIO", {"tooltip": "Optional audio input, passed through unchanged."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("VIDEO", "FLOAT", "STRING")
    RETURN_NAMES = ("VIDEO", "FPS", "stats")
    FUNCTION = "process"
    CATEGORY = "Elvax-nodes/Video"
    DESCRIPTION = "Upscale, interpolate, and add film grain, then provide a disk-backed video for Save Video."

    @classmethod
    def _open_rife(cls, images, low_vram):
        import nodes

        rife_class = nodes.NODE_CLASS_MAPPINGS.get("FL_RIFE")
        if rife_class is None:
            raise RuntimeError("Post Processing requires the FL RIFE node from Fill Nodes.")
        rife = rife_class()
        if low_vram and rife.device.type != "cpu":
            frame_bytes = images.shape[1] * images.shape[2] * images.shape[3] * images.element_size()
            comfy.model_management.free_memory(max(1024 ** 3, frame_bytes * 16), rife.device)
        return rife, rife.load_model("rife49")

    @staticmethod
    def _close_rife(rife):
        if rife is not None:
            rife.model = None
            del rife
            gc.collect()
            comfy.model_management.soft_empty_cache()

    @staticmethod
    def _interpolate_group(images, interpolate_by, rife, model, ensemble, frame_cache, pbar, drop_first=False):
        output = torch.empty((4, *images.shape[1:]), dtype=images.dtype, device=rife.device)
        count = 0
        img0 = frame_cache[0]
        if img0 is None:
            img0 = images[:1].permute(0, 3, 1, 2).to(rife.device)
        if not drop_first:
            output[0].copy_(img0[0].permute(1, 2, 0))
            count = 1
        for index in range(images.shape[0] - 1):
            img1 = images[index + 1:index + 2].permute(0, 3, 1, 2).to(rife.device)
            for step in range(1, interpolate_by):
                pred = rife.make_inference(model, img0, img1, step / interpolate_by, ensemble)
                output[count].copy_(
                    pred[0].permute(1, 2, 0).detach().clamp(0, 1))
                count += 1
                pbar.update(1)
                if count == 4:
                    yield output
                    count = 0
            output[count].copy_(img1[0].permute(1, 2, 0))
            count += 1
            if count == 4:
                yield output
                count = 0
            img0 = img1
        frame_cache[0] = img0
        if count:
            yield output[:count]

    @staticmethod
    def _grain_chunk(batch, intensity, saturation_mix, device):
        batch = batch.to(device)
        grain = torch.randn_like(batch)
        grain[..., 0] *= 2.0
        grain[..., 2] *= 3.0
        gray = grain[..., 1:2]
        noise = grain.mul(saturation_mix)
        noise.add_(gray, alpha=1.0 - saturation_mix).mul_(intensity)
        return batch.add(noise).clamp_(0.0, 1.0).mul_(255).byte().cpu()

    @staticmethod
    def _upscale_group(images, method, scale, executor, frame_cache, drop_first, pbar=None):
        import nodes

        def upscale_frame(index):
            return nodes.ImageScaleBy().upscale(images[index:index + 1], method, scale)[0]

        output = None
        workers = min(PostProcessing._UPSCALE_WORKERS, os.cpu_count() or 1)
        indices = iter(range(int(drop_first), images.shape[0]))
        pending = {}
        for _ in range(min(workers, images.shape[0] - int(drop_first))):
            index = next(indices)
            pending[executor.submit(upscale_frame, index)] = index
        while pending:
            comfy.model_management.throw_exception_if_processing_interrupted()
            done, _ = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
            for future in done:
                index = pending.pop(future)
                chunk = future.result()
                if output is None:
                    output = torch.empty((images.shape[0], *chunk.shape[1:]), dtype=chunk.dtype, device="cpu")
                    if drop_first:
                        output[:1].copy_(frame_cache[0])
                output[index:index + 1].copy_(chunk)
                if pbar is not None:
                    pbar.update(1)
                following = next(indices, None)
                if following is not None:
                    pending[executor.submit(upscale_frame, following)] = following
        frame_cache[0] = output[-1:].clone()
        return output

    def _finish_group(self, images, grain, grain_intensity, saturation_mix):
        if grain:
            device = comfy.model_management.get_torch_device()
            return self._grain_chunk(images, grain_intensity, saturation_mix, device)
        return images.mul(255).clamp_(0, 255).byte().cpu()

    @staticmethod
    def _encode_video(path, frame_rate, batches, cancelled, timings, crf=0,
                      encoder_preset="ultrafast", h264_profile="auto"):
        rate = Fraction(round(frame_rate * 1000), 1000)
        stream = None
        reformatter = VideoReformatter()
        frame_index = 0
        with av.open(path, mode="w", format="mp4") as output:
            while not cancelled.is_set():
                try:
                    batch = batches.get(timeout=0.1)
                except queue.Empty:
                    continue
                if batch is None:
                    break
                started = time.perf_counter()
                if stream is None:
                    stream = output.add_stream("h264", rate=rate)
                    stream.width = batch.shape[2]
                    stream.height = batch.shape[1]
                    stream.pix_fmt = "yuv420p"
                    options = video_encoder_options(Types.VideoCodec.H264, crf, encoder_preset)
                    if h264_profile != "auto":
                        options["profile"] = h264_profile
                    stream.options = options
                    set_video_color_properties(stream.codec_context, "sRGB")
                for image in batch:
                    if cancelled.is_set():
                        return
                    pixels = image.numpy() if image.dtype == torch.uint8 else image.mul(255).clamp_(0, 255).byte().numpy()
                    frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
                    frame = reformatter.reformat(frame, format="yuv420p", dst_colorspace=BT709_NCL)
                    set_video_color_properties(frame, "sRGB")
                    frame.pts = frame_index
                    frame.time_base = Fraction(rate.denominator, rate.numerator)
                    frame_index += 1
                    output.mux(stream.encode(frame))
                timings["Encoding"] += time.perf_counter() - started
                del batch, image, pixels, frame
            if stream is not None and not cancelled.is_set():
                started = time.perf_counter()
                output.mux(stream.encode(None))
                timings["Encoding"] += time.perf_counter() - started

    def process(self, images=None, upscale=True, upscale_method="lanczos", upscale_by=2.0,
                interpolate=True, original_fps=24.0, interpolate_by=2,
                grain=True, grain_intensity=0.025, saturation_mix=0.25,
                batching_mode="normal (64)", custom_batch_size=16, audio_pass=None, unique_id=None,
                dual_pass_rife=False, compress=True, crf=18, video=None,
                encoder_preset="ultrafast", h264_profile="auto"):
        encoding_crf = crf if compress else 0
        if encoding_crf == 0 and h264_profile != "auto":
            raise ValueError(
                "H.264 Baseline/Main/High profiles do not support this encoder's lossless mode. "
                "Set h264_profile to auto, or enable compression with CRF above 0.")
        started = time.perf_counter()
        workflow_started = self._workflow_started
        if video is not None:
            components = video.get_components()
            images = components.images
            original_fps = float(components.frame_rate)
            if audio_pass is None:
                audio_pass = components.audio
        if images is None:
            raise ValueError("Turbo Post Processing needs a video or image batch.")
        frame_count = int(images.shape[0])
        if frame_count == 0:
            raise ValueError("Turbo Post Processing needs at least one frame.")
        batching_mode = batching_mode.lower()
        do_interpolate = interpolate and frame_count > 1
        use_dual_pass_rife = dual_pass_rife
        multiplier = int(interpolate_by) if do_interpolate else 1
        fps = float(original_fps) * multiplier
        group_size = {
            "full sequence": frame_count,
            "normal (64)": 64,
            "low vram (16)": 16,
            "custom": int(custom_batch_size),
        }.get(batching_mode, 64)
        group_size = max(1, min(group_size, frame_count))
        progress_total = (frame_count - 1) * (multiplier - 1) + 1
        for start in range(0, frame_count, group_size):
            source_frames = min(start + group_size, frame_count) - max(0, start - 1)
            processed_frames = (source_frames - 1) * multiplier + 1 - int(start > 0)
            if upscale:
                progress_total += min(group_size, frame_count - start)
            if grain:
                progress_total += (processed_frames + 3) // 4
        pbar = comfy.utils.ProgressBar(progress_total, node_id=unique_id)
        pbar.update_absolute(0)
        timings = {"RIFE": 0.0, "Upscale": 0.0, "Grain": 0.0, "Encoding": 0.0}
        temp_dir = tempfile.TemporaryDirectory(prefix="elvax_turbo_")
        path = os.path.join(temp_dir.name, "video.mp4")
        batches = queue.Queue(maxsize=1)
        cancelled = threading.Event()
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="elvax-video")
        encoder = executor.submit(self._encode_video, path, fps, batches, cancelled, timings,
                                  encoding_crf, encoder_preset, h264_profile)

        def submit_batch(batch):
            while True:
                comfy.model_management.throw_exception_if_processing_interrupted()
                if encoder.done():
                    encoder.result()
                    raise RuntimeError("Turbo's video encoder stopped before receiving all frames.")
                try:
                    batches.put(batch, timeout=0.1)
                    return
                except queue.Full:
                    continue

        rife = model = None
        frame_cache = [None]
        upscale_cache = [None]
        upscale_executor = None
        prepare_executor = None
        prepared = None
        group_frames = batch = pixels = None
        rife_events = None

        def prepare_group(start):
            started = time.perf_counter()
            source = images[max(0, start - 1):min(start + group_size, frame_count)].detach().cpu()
            result = self._upscale_group(
                source, upscale_method, upscale_by, upscale_executor, upscale_cache, start > 0)
            return result, time.perf_counter() - started

        finished = False
        try:
            if upscale:
                upscale_executor = ThreadPoolExecutor(
                    max_workers=min(self._UPSCALE_WORKERS, os.cpu_count() or 1, group_size),
                    thread_name_prefix="elvax-upscale")
            if do_interpolate:
                load_started = time.perf_counter()
                rife, model = self._open_rife(images, batching_mode == "low vram (16)")
                timings["RIFE"] += time.perf_counter() - load_started
                if rife.device.type == "cuda":
                    rife_events = (torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True))
            if upscale and do_interpolate and group_size < frame_count:
                prepare_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="elvax-prepare")
                prepared = prepare_executor.submit(prepare_group, 0)
            for chunk_index, start in enumerate(range(0, frame_count, group_size)):
                end = min(start + group_size, frame_count)
                source = images[max(0, start - 1):end]
                if upscale:
                    if prepared is not None:
                        source, duration = prepared.result()
                        prepared = None
                    else:
                        source, duration = prepare_group(start)
                    timings["Upscale"] += duration
                    pbar.update(end - start)
                    if prepare_executor is not None and end < frame_count:
                        prepared = prepare_executor.submit(prepare_group, end)
                if do_interpolate:
                    group_frames = self._interpolate_group(
                        source, int(interpolate_by), rife, model, use_dual_pass_rife, frame_cache, pbar,
                        chunk_index > 0)
                else:
                    group_frames = (source[index:index + 4]
                                    for index in range(int(chunk_index > 0), source.shape[0], 4))
                while True:
                    stage_started = time.perf_counter()
                    if rife_events is not None:
                        rife_events[0].record(torch.cuda.current_stream(rife.device))
                    try:
                        batch = next(group_frames)
                    except StopIteration:
                        break
                    if rife_events is not None:
                        rife_events[1].record(torch.cuda.current_stream(rife.device))
                    rife_elapsed = time.perf_counter() - stage_started if do_interpolate else 0.0
                    pixels = self._finish_group(batch, grain, grain_intensity, saturation_mix)
                    elapsed = time.perf_counter() - stage_started
                    if rife_events is not None:
                        rife_elapsed = max(rife_elapsed, rife_events[0].elapsed_time(rife_events[1]) / 1000)
                    if do_interpolate:
                        timings["RIFE"] += min(elapsed, rife_elapsed) if grain else elapsed
                    if grain:
                        timings["Grain"] += max(0.0, elapsed - rife_elapsed)
                        pbar.update(1)
                    submit_batch(pixels)
                    batch = pixels = None
                group_frames = None
                del source
            submit_batch(None)
            encoder.result()
            pbar.update(1)
            finished = True
        finally:
            cancelled.set()
            executor.shutdown(wait=True)
            if prepare_executor is not None:
                prepare_executor.shutdown(wait=True, cancel_futures=True)
            prepared = None
            group_frames = batch = pixels = None
            if upscale_executor is not None:
                upscale_executor.shutdown(wait=True, cancel_futures=True)
            upscale_cache[0] = None
            frame_cache[0] = None
            model = None
            self._close_rife(rife)
            if not finished:
                temp_dir.cleanup()

        video = InputImpl.VideoFromList(
            [InputImpl.VideoFromFile(path)], complete_audio=audio_pass, codec=Types.VideoCodec.H264)
        video._elvax_temp_dir = temp_dir
        finished_at = time.perf_counter()
        stats = "Node generation time: {:.2f}s\n{}\n\nTotal Elapsed Time: {}".format(
            finished_at - started,
            "\n".join("{}: {}".format(stage, "Off" if duration < 0.005 else "{:.2f}s".format(duration))
                      for stage, duration in timings.items()),
            "{:.2f}s".format(finished_at - workflow_started) if workflow_started is not None else "Unavailable")
        return (video, fps, stats)


if PromptServer.instance is not None:
    _send_sync = PromptServer.instance.send_sync

    def _track_workflow_time(event, data, sid=None):
        if event == "execution_start":
            PostProcessing._workflow_started = time.perf_counter()
        elif event in ("execution_success", "execution_error", "execution_interrupted"):
            PostProcessing._workflow_started = None
        return _send_sync(event, data, sid)

    PromptServer.instance.send_sync = _track_workflow_time
