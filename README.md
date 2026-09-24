# Elvax Nodes

Custom nodes for ComfyUI.

## LLM Turbo

Runs local GGUF language and vision models through llama.cpp. Select a model from
ComfyUI's configured `LLM` or `text_encoders` folders. For image batches, connect
`images` and select a matching `mmproj`. Enter separate `system_prompt` and
`user_prompt` text; `context_window_size` sits directly below the user prompt.
The `stats` output includes total node execution time and llama.cpp speed figures
when available. GPU and CPU layer placement use llama.cpp defaults. On supported
Windows CUDA systems, the node can download its pinned llama.cpp release if a
matching local binary is not already available.

## H3 Extension Sampler

A single-node MiniMax H3 continuation lane. It performs seamless latent context
bridging, Basic Guider, Custom Advanced sampling, and latent-only overlap
trimming internally. Each instance keeps its own LoRA-fed model, sampler,
sigmas, and seed. Connect `chain_latent` to the next sampler's
`previous_latent`, then decode only the final chain.

## Dynamic Pipe In / Dynamic Pipe Out

Organize multiple connections as one cable. Dynamic Pipe In begins with one
input and adds the next empty input when a value is connected. Dynamic Pipe Out
then creates matching named outputs when the pipe is connected. The nodes carry
data only; they do not alter the values or improve inference performance.

## Installation

Clone this repository into `ComfyUI/custom_nodes`:

```bash
git clone https://github.com/younestft/Elvax-nodes.git
```

Install the Python dependency with the Python environment used by ComfyUI:

```bash
python -m pip install -r ComfyUI/custom_nodes/Elvax-nodes/requirements.txt
```

Restart ComfyUI. The nodes appear under the `Elvax` category.


## License and credits

This repository is licensed under GNU GPL v3 or later; see [LICENSE](LICENSE).

The H3 Extension Sampler is a modified derivative of
[ComfyUI-H3-Motion-Context](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context)
by NikoDemon80. It retains GPL-licensed H3 layout checks, latent-tail slicing,
and timeline-aligned audio-continuation logic.

LLM Turbo is adapted from the GPL-3.0-licensed
[ComfyUI-LLM-text-processor](https://github.com/KingManiya/ComfyUI-LLM-text-processor)
by KingManiya. It retains the GGUF llama.cpp invocation, image conversion, and
response parsing, with Elvax-specific inputs, model discovery, and timing output.
