from .h3_extension_sampler import H3ExtensionSampler
from .h3_reference_samplers import (
    H3ChainSettings,
    H3ReferenceInputs,
    H3SamplerPreview,
    H3SamplerPreviewV2,
    H3StageSettings,
)
from .load_crop_image import LoadCropImage
from .prompt_edit_preview import PromptEditPreview
from .dynamic_pipe import DynamicPipeIn, DynamicPipeOut
from .llm_turbo.nodes import LLMTurbo


NODE_CLASS_MAPPINGS = {
    "ElvaxH3ExtensionSampler": H3ExtensionSampler,
    "ElvaxH3ReferenceInputs": H3ReferenceInputs,
    "ElvaxH3ChainSettings": H3ChainSettings,
    "ElvaxH3StageSettings": H3StageSettings,
    "ElvaxH3SamplerPreview": H3SamplerPreview,
    "ElvaxH3SamplerPreviewV2": H3SamplerPreviewV2,
    "ElvaxLoadCropImage": LoadCropImage,
    "ElvaxPromptEditPreview": PromptEditPreview,
    "ElvaxDynamicPipeIn": DynamicPipeIn,
    "ElvaxDynamicPipeOut": DynamicPipeOut,
    "ElvaxLLMTurbo": LLMTurbo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxH3ExtensionSampler": "H3 Custom Extension Sampler",
    "ElvaxH3ReferenceInputs": "H3 References",
    "ElvaxH3ChainSettings": "H3 Chain Settings",
    "ElvaxH3StageSettings": "H3 Stage Settings",
    "ElvaxH3SamplerPreview": "H3 Sampler Preview",
    "ElvaxH3SamplerPreviewV2": "H3 Sampler Preview v2",
    "ElvaxLoadCropImage": "Load/Crop Image",
    "ElvaxPromptEditPreview": "Prompt Edit / Preview",
    "ElvaxDynamicPipeIn": "Dynamic Pipe In",
    "ElvaxDynamicPipeOut": "Dynamic Pipe Out",
    "ElvaxLLMTurbo": "LLM Turbo",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
