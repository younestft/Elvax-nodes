from comfy_api.latest import io


class PromptEditPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxPromptEditPreview",
            display_name="Prompt Edit / Preview",
            category="Elvax/text",
            search_aliases=[
                "elvax",
                "text preview",
                "text edit",
                "edit text",
                "preview text",
                "text editor",
                "prompt edit",
                "prompt preview",
            ],
            description=(
                "Preview and edit text in one node. Edit the preview text "
                "with one click, then refine it before passing it downstream."),
            inputs=[
                io.String.Input(
                    "source",
                    optional=True,
                    force_input=True,
                    tooltip="Text to preview when mode is set to Preview."),
                io.Boolean.Input(
                    "mode",
                    default=True,
                    socketless=True,
                    label_on="Edit",
                    label_off="Preview",
                    tooltip="Edit the text, or preview and pass through the connected source."),
                io.String.Input("text", multiline=True, socketless=True),
            ],
            outputs=[io.String.Output("prompt")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, source=None, mode=True, text=""):
        preview_source = source is not None and not mode
        value = source if preview_source else text
        preview = {"elvax_prompt_preview": [value]} if preview_source else None
        return io.NodeOutput(value, ui=preview)
