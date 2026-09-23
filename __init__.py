from .lm_studio_prompt_enhancer import LMStudioPromptEnhancer
from .h3_extension_sampler import H3ExtensionSampler


NODE_CLASS_MAPPINGS = {
    "ElvaxLMStudioPromptEnhancer": LMStudioPromptEnhancer,
    "ElvaxH3ExtensionSampler": H3ExtensionSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxLMStudioPromptEnhancer": "LM Studio Prompt Enhancer",
    "ElvaxH3ExtensionSampler": "H3 Extension Sampler",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
