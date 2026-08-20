from .lm_studio_prompt_enhancer import LMStudioPromptEnhancer


NODE_CLASS_MAPPINGS = {
    "ElvaxLMStudioPromptEnhancer": LMStudioPromptEnhancer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ElvaxLMStudioPromptEnhancer": "LM Studio Prompt Enhancer",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
