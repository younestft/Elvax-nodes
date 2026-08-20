# Elvax Nodes

Custom nodes for ComfyUI.

## LM Studio Prompt Enhancer

Generates enhanced prompt text with a locally running LM Studio model.

Features:

- Uses an already loaded LM Studio model when `model_key` is empty.
- Remembers the selected model key so it can reload the model after automatic unloading.
- Supports temperature, Top K, Top P, seed, token limit, and response timeout controls.
- Removes LM Studio reasoning fragments and `<think>` / `<thinking>` blocks.
- Cancels timed-out generation streams and can unload the model immediately to release VRAM.

## Installation

Clone this repository into `ComfyUI/custom_nodes`:

```bash
git clone https://github.com/younestft/Elvax-nodes.git
```

Install the Python dependency with the Python environment used by ComfyUI:

```bash
python -m pip install -r ComfyUI/custom_nodes/Elvax-nodes/requirements.txt
```

Restart ComfyUI. The node appears under the `Elvax` category as **LM Studio Prompt Enhancer**.

LM Studio must be open with its local API server enabled. On the first run with an empty `model_key`, load a model in LM Studio; the node will remember that model for subsequent runs in the same ComfyUI session.

## Credits

The LM Studio integration behavior is based on the MIT-licensed work from [comfyui-lmstudio-image-to-text-node](https://github.com/mattjohnpowell/comfyui-lmstudio-image-to-text-node) by Matt John Powell. See [LICENSE](LICENSE).
