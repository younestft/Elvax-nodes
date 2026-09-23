from .lm_studio_prompt_enhancer import LMStudioPromptEnhancer
from .h3_extension_sampler import H3ExtensionSampler
from .dynamic_pipe import DynamicPipeIn, DynamicPipeOut


NODE_CLASS_MAPPINGS = {
    "ElvaxLMStudioPromptEnhancer": LMStudioPromptEnhancer,
    "ElvaxH3ExtensionSampler": H3ExtensionSampler,
    "ElvaxDynamicPipeIn": DynamicPipeIn,
    "ElvaxDynamicPipeOut": DynamicPipeOut,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxLMStudioPromptEnhancer": "LM Studio Prompt Enhancer",
    "ElvaxH3ExtensionSampler": "H3 Extension Sampler",
    "ElvaxDynamicPipeIn": "Dynamic Pipe In",
    "ElvaxDynamicPipeOut": "Dynamic Pipe Out",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
