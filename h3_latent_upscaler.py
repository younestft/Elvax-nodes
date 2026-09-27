"""H3 AV latent upscaling and stage-wise second-pass sampling.

The 3D latent-resizer architecture is derived from
LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler (MIT). See LICENSE-LBH.txt.
"""

import os
import re

import torch
import torch.nn as nn
import torch.nn.functional as F
import folder_paths
import comfy.nested_tensor
import comfy.model_management
from comfy_api.latest import io
from safetensors.torch import load_file

from .h3_extension_sampler import (
    H3ExtensionBridge,
    H3ExtensionLatentTrim,
    _pixel_frames,
)
from .h3_reference_samplers import (
    H3_EXTENSION_DATA,
    _build_reference_conditioning,
    _sample,
    _validate_extension_data,
)


_MODEL_FOLDER = "latent_upscale_models"
if _MODEL_FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(
        _MODEL_FOLDER, os.path.join(folder_paths.models_dir, _MODEL_FOLDER))

_LATENTS_MEAN = [
    0.858090341091156, -0.9606591463088989, 1.0661640167236328,
    -0.5090325474739075, -0.2727581858634949, -1.3675414323806763,
    -0.2553254961967468, -0.26907554268836975, -0.5376840829849243,
    -0.0464097298681736, 0.6657370328903198, 0.19690127670764923,
    -0.5460608005523682, -0.4035342037677765, -0.23683024942874908,
    0.25928452610969543, -0.30133944749832153, 0.211341992020607,
    -1.1206848621368408, 0.3581933379173279, -0.04225143790245056,
    0.2604829967021942, 0.22864092886447906, 0.7056031823158264,
]
_LATENTS_STD = [
    1.2223774194717407, 1.2767263650894165, 1.6831774711608887,
    1.7549455165863037, 1.5636216402053833, 2.194143533706665,
    0.9653137922286987, 1.0569885969161987, 0.841948926448822,
    0.7729952931404114, 1.8955937623977661, 0.946841835975647,
    0.7996809482574463, 0.449889004230499, 0.7197399735450745,
    0.6936293244361877, 2.961095094680786, 2.7694199085235596,
    3.0496184825897217, 2.1088054180145264, 3.276226282119751,
    3.1627357006073, 2.2816812992095947, 2.6127843856811523,
]


def _norm(channels):
    return nn.GroupNorm(32, channels)


class _ResBlock3D(nn.Module):
    def __init__(self, channels, emb_channels, dropout=0.1):
        super().__init__()
        self.in_layers = nn.Sequential(
            _norm(channels), nn.SiLU(), nn.Conv3d(channels, channels, 3, padding=1))
        self.emb_layers = nn.Sequential(
            nn.SiLU(), nn.Linear(emb_channels, channels * 2))
        self.out_norm = _norm(channels)
        self.out_layers = nn.Sequential(
            nn.SiLU(), nn.Dropout(p=dropout), nn.Conv3d(channels, channels, 3, padding=1))
        nn.init.zeros_(self.out_layers[-1].weight)
        nn.init.zeros_(self.out_layers[-1].bias)
        self.skip = nn.Identity()

    def forward(self, x, emb):
        h = self.in_layers(x)
        scale, shift = self.emb_layers(emb).to(h.dtype).chunk(2, dim=1)
        h = self.out_norm(h) * (1 + scale[:, :, None, None, None]) + shift[:, :, None, None, None]
        return self.skip(x) + self.out_layers(h)


class _TemporalConv3D(nn.Module):
    def __init__(self, channels, kernel_size=5):
        super().__init__()
        self.norm = _norm(channels)
        self.dwconv = nn.Conv3d(
            channels, channels, (kernel_size, 1, 1),
            padding=(kernel_size // 2, 0, 0), groups=channels)
        self.pwconv = nn.Conv3d(channels, channels, 1)
        nn.init.zeros_(self.pwconv.weight)
        nn.init.zeros_(self.pwconv.bias)

    def forward(self, x):
        return x + self.pwconv(self.dwconv(F.silu(self.norm(x))))


class _LatentResizer3D(nn.Module):
    def __init__(self, in_blocks=12, out_blocks=12, channels=512,
                 temporal_kernel=5, temporal_every=2):
        super().__init__()
        self.conv_in = nn.Conv3d(24, channels, 3, padding=1)
        self.embed = nn.Sequential(
            nn.Linear(1, 64), nn.SiLU(), nn.Linear(64, 64))
        self.in_blocks = self._make_blocks(in_blocks, channels, temporal_every, temporal_kernel)
        self.out_blocks = self._make_blocks(out_blocks, channels, temporal_every, temporal_kernel)
        self.norm_out = _norm(channels)
        self.conv_out = nn.Conv3d(channels, 24, 3, padding=1)

    @staticmethod
    def _make_blocks(count, channels, temporal_every, temporal_kernel):
        blocks = []
        for index in range(count):
            blocks.append(_ResBlock3D(channels, 64))
            if temporal_every > 0 and index % temporal_every == 0:
                blocks.append(_TemporalConv3D(channels, temporal_kernel))
        return nn.ModuleList(blocks)

    def _forward_segment(self, x, scale, target_size):
        emb = self.embed(x.new_tensor([[scale - 1.0]]))
        x = self.conv_in(x)
        for block in self.in_blocks:
            x = block(x, emb.expand(x.shape[0], -1)) if isinstance(block, _ResBlock3D) else block(x)
        x = F.interpolate(x, size=target_size, mode="trilinear", align_corners=False)
        for block in self.out_blocks:
            x = block(x, emb.expand(x.shape[0], -1)) if isinstance(block, _ResBlock3D) else block(x)
        return self.conv_out(F.silu(self.norm_out(x)))

    def forward(self, x, scale, target_size, enable_temporal_chunking=True):
        batch, channels, frames, _, _ = x.shape
        temporal = next((block for block in self.in_blocks
                         if isinstance(block, _TemporalConv3D)), None)
        overlap = temporal.dwconv.weight.shape[2] if temporal is not None else 0
        chunk_size = 32
        if not enable_temporal_chunking or frames <= chunk_size or overlap == 0:
            return self._forward_segment(x, scale, target_size)

        padded = F.pad(x, (0, 0, 0, 0, overlap, overlap), mode="replicate")
        output = x.new_zeros((batch, channels, frames, target_size[-2], target_size[-1]))
        weights = x.new_zeros((1, 1, frames, 1, 1))
        for start in range(0, frames, chunk_size):
            end = min(frames, start + chunk_size)
            output_start = max(0, start - overlap)
            output_end = min(frames, end + overlap)
            segment_start = max(0, output_start - overlap)
            segment_end = min(frames + 2 * overlap, output_end + overlap)
            segment = padded[:, :, segment_start:segment_end]
            segment_size = (segment_end - segment_start, target_size[-2], target_size[-1])
            segment_out = self._forward_segment(segment, scale, segment_size)
            slice_start = output_start + overlap - segment_start
            slice_end = slice_start + output_end - output_start
            valid = segment_out[:, :, slice_start:slice_end]
            count = output_end - output_start
            weight = x.new_ones(count)
            if start > output_start:
                blend = start - output_start
                weight[:blend] = torch.arange(1, blend + 1, device=x.device, dtype=x.dtype) / (blend + 1)
            if output_end > end:
                blend = output_end - end
                weight[-blend:] = torch.arange(blend, 0, -1, device=x.device, dtype=x.dtype) / (blend + 1)
            shaped_weight = weight.view(1, 1, count, 1, 1)
            output[:, :, output_start:output_end] += valid * shaped_weight
            weights[:, :, output_start:output_end] += shaped_weight
        return output / weights.clamp(min=1e-8)


def _model_names():
    names = [name for name in folder_paths.get_filename_list(_MODEL_FOLDER)
             if name.lower().endswith((".pth", ".safetensors"))]
    return names or ["(no H3 upscaler model found)"]


def _load_upscaler(model_name, dtype):
    path = folder_paths.get_full_path(_MODEL_FOLDER, model_name)
    if path is None:
        raise FileNotFoundError("H3 Latent Upscaler model not found: " + model_name)
    if path.endswith(".safetensors"):
        state = load_file(path, device="cpu")
    else:
        state = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "model" in state:
        state = state["model"]
    state = {
        key: value.to(torch.float16) if value.dtype == torch.float8_e4m3fn else value
        for key, value in state.items()
    }
    if any(key.startswith("upscaler.") for key in state):
        state = {key[len("upscaler."):]: value for key, value in state.items()
                 if key.startswith("upscaler.")}

    in_ids = {int(match.group(1)) for key in state
              if (match := re.match(r"in_blocks\.(\d+)\.in_layers\.", key))}
    out_ids = {int(match.group(1)) for key in state
               if (match := re.match(r"out_blocks\.(\d+)\.in_layers\.", key))}
    conv = state.get("conv_in.weight")
    channels = int(conv.shape[0]) if conv is not None else 512
    temporal_weight = next(
        (value for key, value in state.items()
         if re.match(r"in_blocks\.\d+\.dwconv\.weight$", key)), None)
    temporal_kernel = int(temporal_weight.shape[2]) if temporal_weight is not None else 5
    temporal_every = 2 if temporal_weight is not None else 0
    model = _LatentResizer3D(
        len(in_ids) or 12, len(out_ids) or 12, channels,
        temporal_kernel, temporal_every)
    model.load_state_dict(state, strict=True)
    return model.to(dtype=dtype).eval()


def _upscale_video(video, model, scale, width, height, dtype, device,
                   enable_temporal_chunking):
    _, _, frames, _, _ = video.shape
    target_size = (frames, height // 16, width // 16)
    x = video.to(device=device, dtype=dtype)
    mean = x.new_tensor(_LATENTS_MEAN).view(1, 24, 1, 1, 1)
    std = x.new_tensor(_LATENTS_STD).view(1, 24, 1, 1, 1)
    x = (x - mean) / std
    y = model(x, scale, target_size, enable_temporal_chunking)
    return (y * std + mean).to(device=video.device, dtype=video.dtype)


class H3LatentUpscaler(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        names = _model_names()
        return io.Schema(
            node_id="ElvaxH3LatentUpscaler",
            display_name="H3 Latent Upscaler",
            category="sampling/minimax",
            description=(
                "Upscale the H3 video latent with the original LBH 3D model, "
                "then refine each stage with its own prompt and references, or use "
                "one shared prompt without references for a single full-chain pass. "
                "Audio is carried through unchanged."),
            inputs=[
                H3_EXTENSION_DATA.Input("extension_in"),
                io.Model.Input("model"),
                io.Combo.Input("upscaler_model", options=names),
                io.Float.Input("scale", default=2.0, min=1.0, max=4.0, step=0.1),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                io.Int.Input(
                    "seed", default=0, min=0, max=0xffffffffffffffff,
                    control_after_generate=True),
                io.Boolean.Input("use_general_prompt", default=False),
                io.String.Input(
                    "general_prompt", multiline=True, dynamic_prompts=True,
                    default=""),
                io.Boolean.Input("enable_temporal_chunking", default=True),
                io.Combo.Input(
                    "precision", options=["fp32", "fp16", "bf16"], default="fp16"),
            ],
            outputs=[io.Latent.Output("latent")],
        )

    @classmethod
    def execute(cls, extension_in, model, upscaler_model, scale, sampler,
                sigmas, seed, use_general_prompt, general_prompt,
                enable_temporal_chunking, precision):
        _validate_extension_data(extension_in)
        stages = extension_in.get("stages")
        if not use_general_prompt:
            if extension_in.get("stage_history_version") != 1 or \
                    extension_in.get("stage_history_complete") is not True:
                raise ValueError(
                    "H3 Latent Upscaler needs complete stage history from the "
                    "current H3 Reference Samplers. Regenerate the chain with the updated nodes.")
            if not isinstance(stages, list) or not stages:
                raise ValueError("H3 Latent Upscaler found no recorded stages.")
        if not upscaler_model:
            raise ValueError(
                "Place an LBH H3 3D upscaler checkpoint in models/latent_upscale_models.")

        dtype = {"fp32": torch.float32, "fp16": torch.float16,
                 "bf16": torch.bfloat16}[precision]
        device = comfy.model_management.get_torch_device()
        source_width = int(extension_in["width"])
        source_height = int(extension_in["height"])
        width = max(32, round(source_width * scale / 32) * 32)
        height = max(32, round(source_height * scale / 32) * 32)
        effective_scale = (width / source_width + height / source_height) / 2
        upscaler = None
        if scale > 1.0:
            upscaler = _load_upscaler(upscaler_model, dtype).to(device=device)

        if use_general_prompt:
            source_video, audio = H3ExtensionLatentTrim._streams(
                extension_in["latent"], "extension chain latent")
            video = source_video if upscaler is None else _upscale_video(
                source_video, upscaler, effective_scale, width, height, dtype,
                device, enable_temporal_chunking)
            if upscaler is not None:
                upscaler.to(device="cpu")
                del upscaler

            conditioning, _ = _build_reference_conditioning(
                extension_in["clip"], {"references": []}, general_prompt,
                width, height, _pixel_frames(int(video.shape[2])),
                extension_in["ref_image_size"], extension_in["video_vae"],
                extension_in["audio_vae"])

            chain_latent = dict(extension_in["latent"])
            chain_latent["samples"] = comfy.nested_tensor.NestedTensor(
                (video, audio))
            sampled = _sample(
                model, conditioning, chain_latent, int(seed), sampler, sigmas)
            sampled_video, sampled_audio = H3ExtensionLatentTrim._streams(
                sampled, "second-pass sampled chain")
            if tuple(sampled_audio.shape) != tuple(audio.shape):
                raise ValueError(
                    "H3 Latent Upscaler second-pass audio shape changed.")
            sampled = dict(sampled)
            sampled["samples"] = comfy.nested_tensor.NestedTensor(
                (sampled_video, audio))
            return io.NodeOutput(sampled)

        upscaled_stages = []
        for index, stage in enumerate(stages):
            if not isinstance(stage, dict) or "sampled_latent" not in stage:
                raise ValueError("H3 Latent Upscaler found an incomplete stage record.")
            video, audio = H3ExtensionLatentTrim._streams(
                stage["sampled_latent"], "stage sampled_latent")
            enlarged_video = video if upscaler is None else _upscale_video(
                video, upscaler, effective_scale, width, height, dtype, device,
                enable_temporal_chunking)
            upscaled_stages.append((stage, enlarged_video, audio))

        if upscaler is not None:
            upscaler.to(device="cpu")
            del upscaler

        chain = None
        trimmer = H3ExtensionLatentTrim()
        for index, (stage, video, audio) in enumerate(upscaled_stages):
            duration_frames = int(stage["duration_frames"])
            prompt = general_prompt if use_general_prompt else stage["prompt"]
            references = {"references": []} if use_general_prompt else stage["references"]
            conditioning, base_latent = _build_reference_conditioning(
                extension_in["clip"], references, prompt,
                width, height, duration_frames, extension_in["ref_image_size"],
                extension_in["video_vae"], extension_in["audio_vae"])
            stage_latent = dict(base_latent)
            base_video, base_audio = H3ExtensionLatentTrim._streams(
                base_latent, "rebuilt stage latent")
            if tuple(base_video.shape) != tuple(video.shape) or \
                    tuple(base_audio.shape) != tuple(audio.shape):
                raise ValueError(
                    "H3 Latent Upscaler stage %d latent shape does not match its "
                    "recorded duration or selected scale." % (index + 1))
            stage_latent["samples"] = comfy.nested_tensor.NestedTensor(
                (video, audio))

            transition_mode = stage.get("transition_mode")
            trim_frames = int(stage.get("trim_frames", 0))
            if index > 0:
                if transition_mode == "motion context":
                    conditioning, stage_latent, bridge_trim = H3ExtensionBridge().bridge(
                        previous_latent=chain,
                        conditioning=conditioning,
                        latent=stage_latent,
                        video_vae=extension_in["video_vae"],
                        context_length=str(int(stage["video_context_length"])),
                        audio_context_length=int(stage["audio_context_length"]),
                    )
                    trim_frames = bridge_trim
                elif transition_mode != "hard cut":
                    raise ValueError(
                        "H3 Latent Upscaler found an unsupported transition mode in stage history.")

            sampled = _sample(
                model, conditioning, stage_latent,
                (int(seed) + index) % (0xffffffffffffffff + 1), sampler, sigmas)
            sampled_video, sampled_audio = H3ExtensionLatentTrim._streams(
                sampled, "second-pass sampled latent")
            if tuple(sampled_audio.shape) != tuple(audio.shape):
                raise ValueError(
                    "H3 Latent Upscaler second-pass audio shape changed in stage %d."
                    % (index + 1))
            sampled = dict(sampled)
            sampled["samples"] = comfy.nested_tensor.NestedTensor(
                (sampled_video, audio))

            chain, _stage_latent = trimmer.trim_latent_and_stage(
                sampled, trim_frames, chain,
                hard_cut=transition_mode == "hard cut" and index > 0)

        return io.NodeOutput(chain)
