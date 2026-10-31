from .nodes.h3_extension_sampler import H3ExtensionSampler
from .nodes.h3_latent_sharpen import H3LatentOperationSharpen
from .nodes.h3_reference_samplers import (
    H3ChainSettings,
    H3ReferenceInputs,
    H3SamplerPreview,
    H3StageSettings,
    H3PrepareReferences,
)
from .nodes.load_crop_image import LoadCropImage
from .nodes.prompt_edit_preview import PromptEditPreview
from .nodes.dynamic_pipe import DynamicPipeIn, DynamicPipeOut
from .llm_turbo.nodes import LLMTurbo
from .nodes.post_processing import PostProcessing
from .nodes.generation_queue_manager import GenerationQueueManager
from .nodes.seed_nodes import ChainSeed, StageSeed
from .nodes.prompt_template_builder import PromptTemplateBuilder
from .nodes.json_prompt_splitter import JSONPromptSplitter
from .nodes.media_compare_pro import MediaComparePro
from .nodes.reroute_switch import RerouteSwitch
from .nodes.circuit_switch import CircuitSwitch


NODE_CLASS_MAPPINGS = {
    "ElvaxH3PrepareReferences": H3PrepareReferences,
    "ElvaxH3ExtensionSampler": H3ExtensionSampler,
    "ElvaxH3LatentOperationSharpen": H3LatentOperationSharpen,
    "ElvaxH3ReferenceInputs": H3ReferenceInputs,
    "ElvaxH3ChainSettings": H3ChainSettings,
    "ElvaxH3StageSettings": H3StageSettings,
    "ElvaxH3SamplerPreview": H3SamplerPreview,
    "ElvaxLoadCropImage": LoadCropImage,
    "ElvaxPromptEditPreview": PromptEditPreview,
    "ElvaxDynamicPipeIn": DynamicPipeIn,
    "ElvaxDynamicPipeOut": DynamicPipeOut,
    "ElvaxLLMTurbo": LLMTurbo,
    "ElvaxPostProcessing": PostProcessing,
    "ElvaxGenerationQueueManager": GenerationQueueManager,
    "ElvaxStageSeed": StageSeed,
    "ElvaxChainSeed": ChainSeed,
    "ElvaxPromptTemplateBuilder": PromptTemplateBuilder,
    "ElvaxJSONPromptSplitter": JSONPromptSplitter,
    "ElvaxMediaComparePro": MediaComparePro,
    "ElvaxRerouteSwitch": RerouteSwitch,
    "ElvaxCircuitSwitch": CircuitSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxH3ExtensionSampler": "H3 Custom Extension Sampler",
    "ElvaxH3LatentOperationSharpen": "H3 Latent Operation Sharpen",
    "ElvaxH3ReferenceInputs": "H3 References",
    "ElvaxH3ChainSettings": "H3 Chain Settings",
    "ElvaxH3StageSettings": "H3 Stage Settings",
    "ElvaxH3SamplerPreview": "H3 Sampler Preview",
    "ElvaxLoadCropImage": "Load/Crop Image",
    "ElvaxPromptEditPreview": "Prompt Edit / Preview",
    "ElvaxDynamicPipeIn": "Dynamic Pipe In",
    "ElvaxDynamicPipeOut": "Dynamic Pipe Out",
    "ElvaxLLMTurbo": "LLM Turbo",
    "ElvaxPostProcessing": "Turbo Post Processing",
    "ElvaxGenerationQueueManager": "Generation Queue Manager",
    "ElvaxStageSeed": "Stage Seed",
    "ElvaxChainSeed": "Chain Seed",
    "ElvaxPromptTemplateBuilder": "Prompt Template Builder",
    "ElvaxJSONPromptSplitter": "JSON Prompt Splitter",
    "ElvaxMediaComparePro": "Media Compare Pro",
    "ElvaxRerouteSwitch": "Reroute Switch",
    "ElvaxCircuitSwitch": "Circuit Switch",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
