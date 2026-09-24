from .h3_extension_sampler import H3ExtensionSampler
from .dynamic_pipe import DynamicPipeIn, DynamicPipeOut
from .llm_turbo.nodes import LLMTurbo


NODE_CLASS_MAPPINGS = {
    "ElvaxH3ExtensionSampler": H3ExtensionSampler,
    "ElvaxDynamicPipeIn": DynamicPipeIn,
    "ElvaxDynamicPipeOut": DynamicPipeOut,
    "ElvaxLLMTurbo": LLMTurbo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxH3ExtensionSampler": "H3 Extension Sampler",
    "ElvaxDynamicPipeIn": "Dynamic Pipe In",
    "ElvaxDynamicPipeOut": "Dynamic Pipe Out",
    "ElvaxLLMTurbo": "LLM Turbo",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
