class QueueReferenceMap:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "refresh"
    OUTPUT_NODE = True
    CATEGORY = "Elvax Nodes/Utilities"
    DESCRIPTION = "Show queued prompts with their first reference image and cancel individual jobs."

    def refresh(self):
        return ()
