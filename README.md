# Elvax Nodes

Convenience nodes for ComfyUI!

## LLM Turbo

Run local GGUF models directly inside ComfyUI through llama.cpp, with no separate
LLM app or external service to set up. Pair system and user prompts with
dynamically growing image or audio inputs, including image batches, and use MTP
where supported. The `stats` output reports total node
runtime and llama.cpp generation speeds. Select models from `models/LLM` or
`models/text_encoders`; image and audio inputs require a compatible model and
projector (`mmproj`).

![LLM Turbo](assets/llm-turbo.gif)

## Load/Crop Image

Load an image, crop it interactively, and send the current image and matching
mask downstream. Refine the crop as often as you like, or restore the original
image at any time.

![Load/Crop Image](assets/load-crop.gif)

## Dynamic Pipe In / Dynamic Pipe Out

Bundle connected values in input order and carry them through a single pipe.
Dynamic Pipe In grows as you connect values; Dynamic Pipe Out unpacks them into
separate outputs in their original order, keeping complex workflows
tidy without changing the values themselves. Supports Set/Get nodes and
Reroutes.

![Dynamic Pipe In and Dynamic Pipe Out](assets/dynamic-pipes.gif)

## Prompt Edit / Preview

Edit prompt text directly or preview text from a connected source before passing
it downstream. Switch between Edit and Preview modes to quickly refine or inspect
generated text in your workflow.

## H3 Staged Samplers

Build a MiniMax H3 generation as a configurable stage-by-stage chain. Set shared
generation parameters once in `H3 Chain Settings`, then tailor each stage with
`H3 Stage Settings`. Use `H3 Sampler Preview` to sample the stage, optionally
show a live tiny-VAE preview or decode the full video, and pass the accumulated
latent into the next stage. Motion Context continues from prior latent context;
Hard Cut starts a fresh joined segment.

`H3 Chain Settings`: Configure the shared settings for a MiniMax H3 extension
chain.

`H3 Stage Settings`: Configure each stage of a MiniMax H3 extension chain
independently.

`H3 Sampler Preview`: Sample a stage, optionally show a live tiny-VAE preview
during sampling or decode a full video preview, and pass the accumulated latent
to the next stage. The `preview_result` toggle controls full video decoding;
live previews are available when a tiny VAE is selected.

`H3 References`: Bundle picture, video, and audio references with MiniMax H3
token labels for use in H3 Stage Settings. Audio slots 1–3 pair with their
matching connected video slots; remaining audio slots are standalone.

## H3 Custom Extension Sampler

Seamlessly extend a MiniMax H3 generation from one sampler stage to the next,
with controls to customize exactly how you want it built. Sampling stays
lightweight: the node returns the accumulated `chain_latent` and this stage's
`stage_latent` without decoding, so you can connect your preferred preview or
decode workflow.

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

LLM Turbo is adapted from the GPL-3.0-licensed
[ComfyUI-LLM-text-processor](https://github.com/KingManiya/ComfyUI-LLM-text-processor)
by KingManiya. It retains the GGUF llama.cpp invocation, image conversion, and
response parsing, with Elvax-specific inputs, model discovery, and timing output.

The H3 Extension Sampler is a modified derivative of
[ComfyUI-H3-Motion-Context](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context)
by NikoDemon80. It retains GPL-licensed H3 layout checks, latent-tail slicing,
and timeline-aligned audio-continuation logic.

The bundled H3 References node is adapted from the GPL-3.0-licensed
[ComfyUI-H3-Prompt-IDE](https://github.com/ethanfel/ComfyUI-H3-Prompt-IDE) by
Ethan Fel. It preserves the input socket labels and reference bundle contract.
