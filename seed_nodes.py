class StageSeed:
    SEARCH_ALIASES = ["elvax", "stage seed", "seed"]
    CATEGORY = "Elvax Nodes/Utilities"
    DESCRIPTION = "provide a seed value with a per-stage mode toggle and new fixed button."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 1125899906842624, "control_after_generate": False}),
                "mode": ("BOOLEAN", {"default": False, "label_on": "random", "label_off": "fixed"}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "get_seed"

    def get_seed(self, seed, mode=False):
        return (seed,)


class ChainSeed:
    SEARCH_ALIASES = ["elvax", "chain seed", "seed"]
    CATEGORY = "Elvax Nodes/Utilities"
    DESCRIPTION = "set every stage seed to all random or all fixed, or assign each a new fixed seed."
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": ("BOOLEAN", {"default": False, "label_on": "all random", "label_off": "all fixed"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "control"

    def control(self, mode=False):
        return ()
