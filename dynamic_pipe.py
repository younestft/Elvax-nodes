"""Dynamic, workflow-safe pipe transport for Elvax Nodes."""

MAX_PIPE_SLOTS = 32
PIPE_TYPE = "ELVAX_DYNAMIC_PIPE"


class DynamicPipeIn:
    """Collect frontend-created value_N inputs into one ordered pipe."""

    CATEGORY = "Elvax/utility"
    RETURN_TYPES = (PIPE_TYPE,)
    RETURN_NAMES = ("pipe",)
    FUNCTION = "pack"
    DESCRIPTION = "Collect dynamically added connections into one ordered pipe."

    @classmethod
    def INPUT_TYPES(cls):
        # Inputs are created by the scoped frontend extension as value_1,
        # value_2, ... . Legacy execution passes undeclared linked inputs to
        # a **kwargs function, which makes the pipe genuinely dynamic.
        return {"optional": {}}

    def pack(self, **kwargs):
        entries = []
        for key in sorted(
            (key for key in kwargs if key.startswith("value_")),
            key=lambda key: int(key.split("_", 1)[1]),
        ):
            value = kwargs[key]
            if value is not None:
                entries.append((key, value))
        return ({"entries": entries},)


class DynamicPipeOut:
    """Restore dynamic-pipe values onto frontend-created output sockets."""

    CATEGORY = "Elvax/utility"
    RETURN_TYPES = ("*",) * MAX_PIPE_SLOTS
    RETURN_NAMES = tuple("value_%d" % index for index in range(1, MAX_PIPE_SLOTS + 1))
    FUNCTION = "unpack"
    DESCRIPTION = "Expose the values stored in an Elvax Dynamic Pipe."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"pipe": (PIPE_TYPE,)}}

    def unpack(self, pipe):
        if not isinstance(pipe, dict) or not isinstance(pipe.get("entries"), list):
            raise ValueError("Elvax Dynamic Pipe Out received an invalid pipe.")
        values = [entry[1] for entry in pipe["entries"]]
        if len(values) > MAX_PIPE_SLOTS:
            raise ValueError(
                "Elvax Dynamic Pipe supports at most %d connections." % MAX_PIPE_SLOTS)
        return tuple(values + [None] * (MAX_PIPE_SLOTS - len(values)))
