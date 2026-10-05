import gc
import os
import tempfile
import time

import comfy.model_management
import comfy.utils
import folder_paths
import numpy as np
import torch


class PostProcessing:
    SEARCH_ALIASES = ["upscale", "interpolate", "grain", "film grain", "rife"]
    _UPSCALE_BATCH_SIZE = 8

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "upscale": ("BOOLEAN", {"default": True}),
                "upscale_method": (["lanczos"], {"default": "lanczos"}),
                "upscale_by": ("FLOAT", {"default": 2.0, "min": 0.01, "max": 8.0, "step": 0.01}),
                "interpolate": ("BOOLEAN", {"default": True}),
                "original_fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.1}),
                "interpolate_by": ("INT", {"default": 2, "min": 2, "max": 10, "step": 1}),
                "grain": ("BOOLEAN", {"default": True}),
                "grain_intensity": ("FLOAT", {"default": 0.025, "min": 0.001, "max": 1.0, "step": 0.001}),
                "saturation_mix": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "low_vram": ("BOOLEAN", {"default": False, "tooltip": "Process intermediate frames through temporary files to reduce memory use. The final IMAGE batch still needs to fit in memory."}),
            },
            "optional": {
                "audio_pass": ("AUDIO", {"tooltip": "Optional audio input, passed through unchanged."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "STRING")
    RETURN_NAMES = ("IMAGES", "AUDIO", "FPS", "stats")
    FUNCTION = "process"
    CATEGORY = "Elvax-nodes/Video"
    DESCRIPTION = "Upscale with Lanczos, interpolate with RIFE 4.9, and add film grain in one fast node, with optional low-VRAM processing."

    @staticmethod
    def _rife_model(images, interpolate_by, low_vram, pbar):
        import nodes

        rife_class = nodes.NODE_CLASS_MAPPINGS.get("FL_RIFE")
        if rife_class is None:
            raise RuntimeError("Post Processing requires the FL RIFE node from Fill Nodes.")

        rife = rife_class()

        if low_vram and rife.device.type != "cpu":
            frame_bytes = images.shape[1] * images.shape[2] * images.shape[3] * images.element_size()
            comfy.model_management.free_memory(max(1024 ** 3, frame_bytes * 16), rife.device)

        model = None
        pred = img0 = img1 = None
        try:
            model = rife.load_model("rife49")
            output = []
            for index in range(images.shape[0] - 1):
                frame0 = images[index:index + 1]
                frame1 = images[index + 1:index + 2]
                output.append(frame0.cpu())
                img0 = frame0.permute(0, 3, 1, 2).to(rife.device)
                img1 = frame1.permute(0, 3, 1, 2).to(rife.device)
                for step in range(1, interpolate_by):
                    pred = rife.make_inference(model, img0, img1, step / interpolate_by, True)
                    output.append(pred.permute(0, 2, 3, 1).cpu().clamp(0, 1))
                    pbar.update(1)
                del img0, img1
            output.append(images[-1:].cpu())
            return torch.cat(output, dim=0)
        finally:
            rife.model = None
            model = None
            pred = img0 = img1 = None
            del rife
            gc.collect()
            comfy.model_management.soft_empty_cache()

    @staticmethod
    def _save_frame(path, frame):
        np.save(path, frame.detach().cpu().numpy())

    @classmethod
    def _grain_chunk(cls, batch, intensity, saturation_mix, device):
        batch = batch.to(device)
        grain = torch.randn_like(batch)
        grain[:, :, :, 0] *= 2.0
        grain[:, :, :, 2] *= 3.0
        gray = grain[:, :, :, 1].unsqueeze(3).repeat(1, 1, 1, 3)
        grain = saturation_mix * grain + (1.0 - saturation_mix) * gray
        output = (batch + grain * intensity).clamp(0.0, 1.0).cpu()
        return output

    @classmethod
    def _process_low_vram(cls, images, upscale, upscale_method, upscale_by, interpolate,
                          interpolate_by, grain, grain_intensity,
                          saturation_mix, pbar):
        import nodes

        temp_dir = folder_paths.get_temp_directory()
        frame_count = images.shape[0]
        with tempfile.TemporaryDirectory(prefix="elvax_post_", dir=temp_dir) as work_dir:
            source_paths = []
            for index in range(frame_count):
                frame = images[index:index + 1]
                if upscale:
                    frame = nodes.ImageScaleBy().upscale(frame, upscale_method, upscale_by)[0]
                path = os.path.join(work_dir, f"source_{index:08d}.npy")
                cls._save_frame(path, frame[0])
                source_paths.append(path)
                del frame
                pbar.update(1)

            if interpolate and frame_count > 1:
                interp = nodes.NODE_CLASS_MAPPINGS.get("FL_RIFE")
                if interp is None:
                    raise RuntimeError("Post Processing requires the FL RIFE node from Fill Nodes.")
                probe = interp()
                frame = torch.from_numpy(np.load(source_paths[0])).unsqueeze(0)
                frame_bytes = frame.shape[1] * frame.shape[2] * frame.shape[3] * frame.element_size()
                if probe.device.type != "cpu":
                    comfy.model_management.free_memory(max(1024 ** 3, frame_bytes * 16), probe.device)
                output_paths = []
                model = None
                try:
                    model = probe.load_model("rife49")
                    for index in range(frame_count - 1):
                        frame0 = torch.from_numpy(np.load(source_paths[index])).unsqueeze(0)
                        frame1 = torch.from_numpy(np.load(source_paths[index + 1])).unsqueeze(0)
                        first_path = os.path.join(work_dir, f"interpolated_{len(output_paths):08d}.npy")
                        cls._save_frame(first_path, frame0[0])
                        output_paths.append(first_path)
                        img0 = frame0.permute(0, 3, 1, 2).to(probe.device)
                        img1 = frame1.permute(0, 3, 1, 2).to(probe.device)
                        for step in range(1, interpolate_by):
                            pred = probe.make_inference(model, img0, img1, step / interpolate_by, True)
                            pred = pred.permute(0, 2, 3, 1).cpu().clamp(0, 1)
                            path = os.path.join(work_dir, f"interpolated_{len(output_paths):08d}.npy")
                            cls._save_frame(path, pred[0])
                            output_paths.append(path)
                            pbar.update(1)
                        os.remove(source_paths[index])
                        del frame0, frame1, img0, img1
                    last_path = os.path.join(work_dir, f"interpolated_{len(output_paths):08d}.npy")
                    cls._save_frame(last_path, torch.from_numpy(np.load(source_paths[-1])))
                    output_paths.append(last_path)
                finally:
                    probe.model = None
                    model = None
                    del probe
                    gc.collect()
                    comfy.model_management.soft_empty_cache()
                source_paths = output_paths

            if grain:
                device = comfy.model_management.get_torch_device()
                batch_size = 1
                for start in range(0, len(source_paths), batch_size):
                    paths = source_paths[start:start + batch_size]
                    batch = torch.stack([torch.from_numpy(np.load(path)) for path in paths])
                    result = cls._grain_chunk(batch, grain_intensity, saturation_mix, device)
                    for offset, path in enumerate(paths):
                        temp_path = path + ".tmp.npy"
                        cls._save_frame(temp_path, result[offset])
                        os.replace(temp_path, path)
                    del batch, result
                    pbar.update(1)

            sample = torch.from_numpy(np.load(source_paths[0]))
            output = torch.empty(
                (len(source_paths), *sample.shape),
                dtype=sample.dtype,
                device=comfy.model_management.intermediate_device(),
            )
            for index, path in enumerate(source_paths):
                output[index].copy_(torch.from_numpy(np.load(path)).to(output.device))
                pbar.update(1)
            return output

    @classmethod
    def _process_in_memory(cls, images, upscale, upscale_method, upscale_by, interpolate,
                           interpolate_by, grain, grain_intensity,
                           saturation_mix, pbar):
        import nodes

        result = images
        if upscale:
            upscaled = None
            for start in range(0, result.shape[0], cls._UPSCALE_BATCH_SIZE):
                chunk = nodes.ImageScaleBy().upscale(
                    result[start:start + cls._UPSCALE_BATCH_SIZE], upscale_method, upscale_by)[0]
                if upscaled is None:
                    upscaled = chunk.new_empty((result.shape[0], *chunk.shape[1:]))
                upscaled[start:start + chunk.shape[0]].copy_(chunk)
                del chunk
                pbar.update(1)
            result = upscaled
        if interpolate and result.shape[0] > 1:
            result = cls._rife_model(result, interpolate_by, False, pbar)
        if grain:
            device = comfy.model_management.get_torch_device()
            chunks = []
            for start in range(0, result.shape[0], 4):
                chunks.append(cls._grain_chunk(
                    result[start:start + 4], grain_intensity, saturation_mix, device))
                pbar.update(1)
            result = torch.cat(chunks, dim=0).to(comfy.model_management.intermediate_device())
        return result

    def process(self, images, upscale=True, upscale_method="lanczos", upscale_by=2.0,
                interpolate=True, original_fps=24.0, interpolate_by=2,
                grain=True, grain_intensity=0.025, saturation_mix=0.25,
                low_vram=False, audio_pass=None, unique_id=None):
        started = time.perf_counter()
        frame_count = int(images.shape[0])
        do_interpolate = interpolate and frame_count > 1
        output_frame_count = (frame_count - 1) * int(interpolate_by) + 1 if do_interpolate else frame_count
        if low_vram:
            input_steps = frame_count
        else:
            input_steps = (frame_count + self._UPSCALE_BATCH_SIZE - 1) // self._UPSCALE_BATCH_SIZE if upscale else 0
        interpolation_steps = (frame_count - 1) * (int(interpolate_by) - 1) if do_interpolate else 0
        grain_batch_size = 1 if low_vram else 4
        grain_steps = (output_frame_count + grain_batch_size - 1) // grain_batch_size if grain else 0
        assembly_steps = output_frame_count if low_vram else 0
        progress_total = input_steps + interpolation_steps + grain_steps + assembly_steps
        pbar = comfy.utils.ProgressBar(progress_total, node_id=unique_id) if progress_total else None
        if pbar is not None:
            pbar.update_absolute(0)
        if low_vram:
            result = self._process_low_vram(
                images, upscale, upscale_method, upscale_by, interpolate, interpolate_by,
                grain, grain_intensity, saturation_mix, pbar)
        else:
            result = self._process_in_memory(
                images, upscale, upscale_method, upscale_by, interpolate, interpolate_by,
                grain, grain_intensity, saturation_mix, pbar)

        did_interpolate = interpolate and images.shape[0] > 1
        fps = float(original_fps) * (int(interpolate_by) if did_interpolate else 1)
        stats = "Generation time: {:.2f}s".format(time.perf_counter() - started)
        return (result, audio_pass, fps, stats)
