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

A single-node MiniMax H3 generation lane. Each instance keeps its own LoRA-fed
model, sampler, sigmas, and seed. Its **Transition Mode** dropdown offers:

- `Full Latent Extension`: carries the preceding video and audio latents as
  continuation context and trims their repeated head.
- `Visual Guide Only`: decodes and re-encodes the preceding video tail as visual
  guidance; it does not carry the preceding audio.
- `Hard Cut`: samples without preceding-stage conditioning and joins with no
  conditioning overlap. To keep the accumulated H3 latent decodable as one
  stream, it trims the new stage's first 5 video frames at each join.

Hover over the selected transition mode for its explanation. Connect the H3
video and audio VAEs for its stage preview, and connect `chain_latent` to the
next sampler's `previous_latent`. `preview_images` and `preview_audio` are
decoded and trimmed inside the sampler, so each stage can go directly to its
own Video Combine node. `chain_latent` remains the accumulated stream for the
next sampler or final decode.

## H3 Reference Samplers

`H3 Initial Reference Sampler` builds native MiniMax H3 reference conditioning
from a prompt and an `H3 Reference Inputs` bundle, then samples the first stage.
`H3 Extension Reference Sampler` builds the next stage's conditioning and
extends the latent chain. It carries the initial CLIP, VAEs, dimensions,
reference sizing, sampler, sigmas, and duration through `extension_out`; each
extension still accepts its own model, reference bundle, prompt, duration, and
seed. Durations snap to H3's valid frame counts. Enable `use_initial_duration`
on an extension to reuse the initial sampler's duration instead of its local
`duration_s` value.

`motion context` carries prior latent context into the next stage. `hard cut`
trims and joins the latent only; decoding the final chain may soften a few seam
frames. The `enable_preview` true/false toggle skips stage-preview decoding and
blocks both preview outputs when false.

The bundled `H3 Reference Inputs` node uses the same `H3_PROMPT_REFERENCES`
wire type and payload as the H3 Prompt IDE reference node. It works with the
new samplers without the Prompt IDE pack. When the Prompt IDE is installed, its
reference palette and previews recognize the Elvax node ID through a small
frontend alias in the local Prompt IDE installation.

Audio slots 1-3 pair with the matching video slot when that video is connected;
otherwise they act as standalone audio. Slots 4-6 are standalone audio.

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

The bundled H3 Reference Inputs node is adapted from the GPL-3.0-licensed
[ComfyUI-H3-Prompt-IDE](https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE) by
Ethan Fel. It preserves the input socket labels and reference bundle contract.

LLM Turbo is adapted from the GPL-3.0-licensed
[ComfyUI-LLM-text-processor](https://github.com/KingManiya/ComfyUI-LLM-text-processor)
by KingManiya. It retains the GGUF llama.cpp invocation, image conversion, and
response parsing, with Elvax-specific inputs, model discovery, and timing output.
