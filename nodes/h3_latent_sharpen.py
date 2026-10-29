import torch

from comfy.nested_tensor import NestedTensor
from comfy_api.latest import io
from comfy_extras.nodes_post_processing import gaussian_kernel


class H3LatentOperationSharpen(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxH3LatentOperationSharpen",
            display_name="H3 Latent Operation Sharpen",
            search_aliases=["elvax", "minimax image sharpen"],
            category="Elvax/latent",
            description=(
                "Sharpen H3 image latents before VAE decoding. Connect operation "
                "to LatentApplyOperation. Audio streams are left unchanged. "
                "This changes latent detail and may introduce artifacts."),
            inputs=[
                io.Int.Input("sharpen_radius", default=9, min=1, max=31, step=1),
                io.Float.Input("sigma", default=1.0, min=0.1, max=10.0, step=0.1),
                io.Float.Input("alpha", default=0.1, min=0.0, max=5.0, step=0.01),
            ],
            outputs=[io.LatentOperation.Output()],
        )

    @classmethod
    def execute(cls, sharpen_radius, sigma, alpha):
        def sharpen(latent, **kwargs):
            if alpha == 0:
                return latent
            streams = latent.unbind() if isinstance(latent, NestedTensor) else None
            image = streams[0] if streams is not None else latent
            if image.ndim not in (4, 5):
                raise ValueError("H3 latent sharpening expects [B,C,H,W] or [B,C,T,H,W] image samples.")
            shape = image.shape
            if image.ndim == 5:
                image = image.movedim(2, 1).reshape(-1, shape[1], shape[3], shape[4])

            magnitude = (torch.linalg.vector_norm(image, dim=1) + 1e-6)[:, None]
            normalized = image / magnitude
            kernel = gaussian_kernel(
                sharpen_radius * 2 + 1, sigma, device=image.device).to(dtype=image.dtype)
            kernel = kernel * (-10 * alpha)
            kernel[sharpen_radius, sharpen_radius] += 1 - kernel.sum()
            padded = torch.nn.functional.pad(
                normalized, (sharpen_radius,) * 4, mode="reflect")
            sharpened = torch.nn.functional.conv2d(
                padded, kernel[None, None].repeat(shape[1], 1, 1, 1), groups=shape[1])
            result = magnitude * sharpened
            if len(shape) == 5:
                result = result.reshape(shape[0], shape[2], shape[1], shape[3], shape[4]).movedim(1, 2)
            if streams is not None:
                return NestedTensor([result, *streams[1:]])
            return result

        return io.NodeOutput(sharpen)
