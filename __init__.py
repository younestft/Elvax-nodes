from .h3_extension_sampler import H3ExtensionSampler
from .h3_reference_samplers import (
    H3ExtensionReferenceSampler,
    H3InitialReferenceSampler,
    H3ReferenceInputs,
)
from .dynamic_pipe import DynamicPipeIn, DynamicPipeOut
from .llm_turbo.nodes import LLMTurbo


NODE_CLASS_MAPPINGS = {
    "ElvaxH3ExtensionSampler": H3ExtensionSampler,
    "ElvaxH3ReferenceInputs": H3ReferenceInputs,
    "ElvaxH3InitialReferenceSampler": H3InitialReferenceSampler,
    "ElvaxH3ExtensionReferenceSampler": H3ExtensionReferenceSampler,
    "ElvaxDynamicPipeIn": DynamicPipeIn,
    "ElvaxDynamicPipeOut": DynamicPipeOut,
    "ElvaxLLMTurbo": LLMTurbo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxH3ExtensionSampler": "H3 Extension Sampler",
    "ElvaxH3ReferenceInputs": "H3 Reference Inputs",
    "ElvaxH3InitialReferenceSampler": "H3 Initial Reference Sampler",
    "ElvaxH3ExtensionReferenceSampler": "H3 Extension Reference Sampler",
    "ElvaxDynamicPipeIn": "Dynamic Pipe In",
    "ElvaxDynamicPipeOut": "Dynamic Pipe Out",
    "ElvaxLLMTurbo": "LLM Turbo",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
