"""Standalone MiniMax H3 reference samplers for Elvax-nodes.

The reference-input bundle follows the public H3_PROMPT_REFERENCES contract
used by ComfyUI-H3-Prompt-IDE. Its reference-input implementation is adapted
from that GPL-3.0 project; see the attribution below and the pack LICENSE.
"""

import re

import nodes
from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker
from comfy_extras.nodes_audio import vae_decode_audio
from comfy_extras.nodes_custom_sampler import (
    Guider_Basic,
    Noise_RandomNoise,
    SamplerCustomAdvanced,
)
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo

from .h3_extension_sampler import (
    H3ExtensionBridge,
    H3ExtensionLatentTrim,
    MiniMaxH3MotionContextTrim,
    _decode_video_frames,
)


# Shared wire type and payload format with ethanfel/ComfyUI-H3-Prompt-IDE.
H3_PROMPT_REFERENCES = io.Custom("H3_PROMPT_REFERENCES")
H3_EXTENSION_DATA = io.Custom("ELVAX_H3_EXTENSION_DATA")

PICTURE_NAMES = [f"<Picture {index}>" for index in range(1, 10)]
VIDEO_NAMES = [f"<Video {index}>" for index in range(1, 4)]
AUDIO_NAMES = [f"<Audio {index}>" for index in range(1, 7)]
MIN_H3_FRAMES = 5
MAX_H3_FRAMES = 362
H3_FPS = 24
H3_FRAME_STEP = 17


def _duration_to_h3_frames(duration_s):
    """Round seconds to the next H3 frame count on the 17n+5 grid."""
    duration_s = float(duration_s)
    min_duration = MIN_H3_FRAMES / H3_FPS
    max_duration = MAX_H3_FRAMES / H3_FPS
    duration_s = min(max(duration_s, min_duration), max_duration)
    frames = max(MIN_H3_FRAMES, round(duration_s * H3_FPS))
    frames += (5 - frames % H3_FRAME_STEP) % H3_FRAME_STEP
    return min(frames, MAX_H3_FRAMES)


def _reference_records(source, names, kind, value_key):
    values = source or {}
    records = []
    for token in names:
        value = values.get(token)
        if value is not None:
            records.append({"token": token, "kind": kind, value_key: value})
    return records


def _slot_number(token, prefix, maximum):
    if not isinstance(token, str) or not token.startswith(prefix) or not token.endswith(">"):
        raise ValueError("h3_reference_sampler: malformed H3 reference token %r." % token)
    try:
        number = int(token[len(prefix):-1])
    except ValueError as exc:
        raise ValueError("h3_reference_sampler: malformed H3 reference token %r." % token) from exc
    if not 1 <= number <= maximum:
        raise ValueError("h3_reference_sampler: reference token %r is out of range." % token)
    return number


def _reference_slots(records, prefix, maximum):
    slots = {}
    for record in records:
        number = _slot_number(record.get("token"), prefix, maximum)
        if number in slots:
            raise ValueError("h3_reference_sampler: duplicate reference token %s%d>." % (prefix, number))
        slots[number] = record
    return dict(sorted(slots.items()))


def _native_reference_inputs(references):
    if not isinstance(references, dict) or not isinstance(references.get("references"), list):
        raise ValueError(
            "h3_reference_sampler: references must come from an H3 Reference Inputs node.")

    records = references["references"]
    if any(not isinstance(item, dict) for item in records):
        raise ValueError("h3_reference_sampler: malformed reference bundle record.")
    unknown_kinds = sorted(
        {item.get("kind") for item in records} - {"picture", "video", "audio"})
    if unknown_kinds:
        raise ValueError(
            "h3_reference_sampler: unsupported reference kind(s): %s."
            % ", ".join(str(kind) for kind in unknown_kinds))
    pictures = _reference_slots(
        [item for item in records if item.get("kind") == "picture"],
        "<Picture ", 9)
    videos = _reference_slots(
        [item for item in records if item.get("kind") == "video"],
        "<Video ", 3)
    audios = _reference_slots(
        [item for item in records if item.get("kind") == "audio"],
        "<Audio ", 6)

    # The native encoder numbers only connected references. Re-key media into
    # dense native slots and keep a token map so sparse Prompt IDE labels still
    # refer to the same media in the encoded prompt.
    ref_images = {}
    token_map = {}
    for native_number, (source_number, item) in enumerate(pictures.items(), 1):
        ref_images["ref_image_%d" % native_number] = item["image"]
        token_map["<Picture %d>" % source_number] = "<Picture %d>" % native_number

    ref_videos = {}
    native_video_numbers = {}
    for native_number, (source_number, item) in enumerate(videos.items(), 1):
        if "frames" not in item:
            raise ValueError(
                "h3_reference_sampler: <Video %d> has no frame data." % source_number)
        ref_videos["ref_video_%d" % native_number] = item["frames"]
        native_video_numbers[source_number] = native_number
        token_map["<Video %d>" % source_number] = "<Video %d>" % native_number

    # Audio 1-3 pair with matching video slots when present; without that video
    # they work as standalone audio. Audio 4-6 are always standalone. The
    # native encoder presents all connected soundtracks first, then standalone
    # audio, so translate source labels to that compact order.
    ref_video_audios = {}
    ref_audios = {}
    native_audio_number = 0
    standalone_number = 0
    soundtracks = {
        number: item for number, item in audios.items()
        if number <= 3 and number in videos
    }
    standalone = {
        number: item for number, item in audios.items()
        if number > 3 or number not in videos
    }
    for number, item in soundtracks.items():
        if "audio" not in item:
            raise ValueError(
                "h3_reference_sampler: <Audio %d> has no audio data." % number)
        native_audio_number += 1
        native_video_number = native_video_numbers[number]
        ref_video_audios["ref_video_audio_%d" % native_video_number] = item["audio"]
        token_map["<Audio %d>" % number] = "<Audio %d>" % native_audio_number

    for number, item in standalone.items():
        if "audio" not in item:
            raise ValueError(
                "h3_reference_sampler: <Audio %d> has no audio data." % number)
        native_audio_number += 1
        standalone_number += 1
        ref_audios["ref_audio_%d" % standalone_number] = item["audio"]
        token_map["<Audio %d>" % number] = "<Audio %d>" % native_audio_number

    return {
        "ref_images": ref_images,
        "ref_videos": ref_videos,
        "ref_video_audios": ref_video_audios,
        "ref_audios": ref_audios,
    }, token_map


def _build_reference_conditioning(
    clip, references, prompt, width, height, length, ref_image_size,
    video_vae, audio_vae,
):
    ref_inputs, token_map = _native_reference_inputs(references)
    prompt_tags = set(re.findall(r"<(Picture|Video|Audio) (\d+)>", prompt))
    prompt_tags = {"<%s %s>" % tag for tag in prompt_tags}
    missing = sorted(prompt_tags.difference(token_map))
    if missing:
        raise ValueError(
            "h3_reference_sampler: prompt uses unconnected reference token(s): %s."
            % ", ".join(missing))
    prompt = re.sub(
        r"<(Picture|Video|Audio) (\d+)>",
        lambda match: token_map.get(match.group(0), match.group(0)),
        prompt,
    )
    result = MiniMaxH3ReferenceToVideo.execute(
        clip=clip,
        prompt=prompt,
        width=width,
        height=height,
        length=length,
        ref_image_size=ref_image_size,
        vae=video_vae,
        audio_vae=audio_vae,
        **ref_inputs,
    )
    return result.result


def _sample(model, conditioning, latent, seed, sampler, sigmas):
    guider = Guider_Basic(model)
    guider.set_conds(conditioning)
    noise = Noise_RandomNoise(int(seed))
    return SamplerCustomAdvanced.sample(noise, guider, sampler, sigmas, latent)[0]


def _stage_preview(sampled_latent, video_vae, audio_vae, trim_frames, enabled):
    if not enabled:
        blocker = ExecutionBlocker(None)
        return blocker, blocker

    video, audio = H3ExtensionLatentTrim._streams(sampled_latent, "sampled_latent")
    images = _decode_video_frames(video_vae, video, "sampled")
    sound = vae_decode_audio(audio_vae, {"samples": audio})
    return MiniMaxH3MotionContextTrim().trim(
        images=images,
        trim_frames=trim_frames,
        audio=sound,
        fps=24,
        match_tail=True,
    )


def _make_extension_data(latent, clip, video_vae, audio_vae, width, height,
                         ref_image_size, sampler, sigmas, initial_duration_s):
    return {
        "version": 1,
        "latent": latent,
        "clip": clip,
        "video_vae": video_vae,
        "audio_vae": audio_vae,
        "width": int(width),
        "height": int(height),
        "ref_image_size": ref_image_size,
        "sampler": sampler,
        "sigmas": sigmas,
        "initial_duration_s": float(initial_duration_s),
    }


def _validate_extension_data(data):
    fields = (
        "latent", "clip", "video_vae", "audio_vae", "width", "height",
        "ref_image_size", "sampler", "sigmas",
        "initial_duration_s",
    )
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError(
            "h3_extension_sampler: extension_in must come from H3 Initial "
            "Reference Sampler or H3 Extension Reference Sampler.")
    missing = [key for key in fields if key not in data]
    if missing:
        raise ValueError(
            "h3_extension_sampler: extension_in is missing %s."
            % ", ".join(missing))


class H3ReferenceInputs(io.ComfyNode):
    """Collect H3 media with the same custom bundle contract as H3 Prompt IDE.

    Adapted from ethanfel/ComfyUI-H3-Prompt-IDE, copyright Ethan Fel,
    distributed under GPL-3.0.
    """

    @classmethod
    def define_schema(cls):
        pictures = io.Autogrow.TemplateNames(
            input=io.Image.Input(
                "picture",
                tooltip=(
                    "Reference picture for the matching MiniMax H3 token. "
                    "The next socket appears automatically when connected."),
            ),
            names=PICTURE_NAMES,
            min=0,
        )
        videos = io.Autogrow.TemplateNames(
            input=io.Image.Input(
                "video",
                tooltip=(
                    "Reference video frames for the matching MiniMax H3 token. "
                    "Use the same IMAGE frame batch sent to the native H3 "
                    "ref_videos input."),
            ),
            names=VIDEO_NAMES,
            min=0,
        )
        audios = io.Autogrow.TemplateNames(
            input=io.Audio.Input(
                "audio",
                tooltip=(
                    "Reference audio for the matching MiniMax H3 token. Audio "
                    "labels follow native presentation order: connected video "
                    "soundtracks first, then standalone audio."),
            ),
            names=AUDIO_NAMES,
            min=0,
        )
        return io.Schema(
            node_id="ElvaxH3ReferenceInputs",
            display_name="H3 Reference Inputs",
            category="text/H3 Prompt IDE",
            search_aliases=[
                "h3 ref input",
                "h3 reference media",
                "h3 reference images videos audio",
                "minimax picture video audio references",
            ],
            description=(
                "Authoring references for H3 Prompt IDE. Picture, video-frame, "
                "and audio sockets auto-grow with native MiniMax H3 labels. "
                "Connect the references output to the editor."),
            inputs=[
                io.Autogrow.Input(
                    "pictures", optional=True, template=pictures,
                    tooltip=(
                        "Up to nine prompt reference pictures, numbered in "
                        "their H3 presentation order.")),
                io.Autogrow.Input(
                    "videos", optional=True, template=videos,
                    tooltip=(
                        "Up to three reference video frame batches, numbered "
                        "<Video 1> through <Video 3>.")),
                io.Autogrow.Input(
                    "audios", optional=True, template=audios,
                    tooltip=(
                        "Up to six emitted H3 audio labels: video soundtracks "
                        "first, then standalone audio.")),
            ],
            outputs=[
                H3_PROMPT_REFERENCES.Output(
                    "references",
                    tooltip="Authoring references for H3 Prompt IDE."),
            ],
        )

    @classmethod
    def execute(cls, pictures=None, videos=None, audios=None):
        picture_records = _reference_records(
            pictures, PICTURE_NAMES, "picture", "image")
        video_records = _reference_records(
            videos, VIDEO_NAMES, "video", "frames")
        audio_records = _reference_records(
            audios, AUDIO_NAMES, "audio", "audio")
        return io.NodeOutput({
            "pictures": picture_records,
            "videos": video_records,
            "audios": audio_records,
            "references": picture_records + video_records + audio_records,
        })


class H3InitialReferenceSampler(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxH3InitialReferenceSampler",
            display_name="H3 Initial Reference Sampler",
            category="sampling/minimax",
            description=(
                "Build native H3 reference conditioning and sample the first "
                "stage. Preview off skips video/audio preview decoding."),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input("video_vae"),
                io.Vae.Input("audio_vae"),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                H3_PROMPT_REFERENCES.Input("references"),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input(
                    "seed", default=0, min=0, max=0xffffffffffffffff,
                    control_after_generate=True),
                io.Int.Input("width", default=1344, min=32, max=nodes.MAX_RESOLUTION, step=32),
                io.Int.Input("height", default=768, min=32, max=nodes.MAX_RESOLUTION, step=32),
                io.Float.Input(
                    "duration_s",
                    default=124 / H3_FPS,
                    min=MIN_H3_FRAMES / H3_FPS,
                    max=MAX_H3_FRAMES / H3_FPS,
                    step=H3_FRAME_STEP / H3_FPS,
                    tooltip=(
                        "Duration in seconds. Steps follow valid H3 lengths; "
                        "typed values round up to a valid length when sampling.")),
                io.Combo.Input("ref_image_size", options=["match", "max"], default="match"),
                io.Boolean.Input(
                    "enable_preview", default=True,
                    tooltip=(
                        "Off skips decoding the stage preview and blocks both "
                        "preview outputs, even if they are connected.")),
            ],
            outputs=[
                H3_EXTENSION_DATA.Output("extension_out"),
                io.Latent.Output("latent"),
                io.Image.Output("preview_images"),
                io.Audio.Output("preview_audio"),
            ],
        )

    @classmethod
    def execute(cls, model, clip, video_vae, audio_vae, sampler, sigmas,
                references, prompt, width, height, duration_s, ref_image_size,
                seed, enable_preview):
        conditioning, base_latent = _build_reference_conditioning(
            clip, references, prompt, width, height,
            _duration_to_h3_frames(duration_s), ref_image_size,
            video_vae, audio_vae)
        sampled_latent = _sample(
            model, conditioning, base_latent, seed, sampler, sigmas)
        preview_images, preview_audio = _stage_preview(
            sampled_latent, video_vae, audio_vae, 0, enable_preview)
        extension_out = _make_extension_data(
            sampled_latent, clip, video_vae, audio_vae, width, height,
            ref_image_size, sampler, sigmas,
            _duration_to_h3_frames(duration_s) / H3_FPS)
        return io.NodeOutput(
            extension_out, sampled_latent, preview_images, preview_audio)


class H3ExtensionReferenceSampler(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ElvaxH3ExtensionReferenceSampler",
            display_name="H3 Extension Reference Sampler",
            category="sampling/minimax",
            description=(
                "Continue the H3 latent chain using stage-specific references "
                "and prompt. Hard Cut is latent-only; final VAE decoding may "
                "soften the seam. Preview off skips stage preview decoding."),
            inputs=[
                H3_EXTENSION_DATA.Input("extension_in"),
                io.Model.Input("model"),
                H3_PROMPT_REFERENCES.Input("references"),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input(
                    "seed", default=0, min=0, max=0xffffffffffffffff,
                    control_after_generate=True),
                io.Boolean.Input(
                    "use_initial_duration", default=False,
                    tooltip=(
                        "Use the duration selected in H3 Initial Reference "
                        "Sampler. When enabled, the local duration field is ignored.")),
                io.Float.Input(
                    "duration_s",
                    default=124 / H3_FPS,
                    min=MIN_H3_FRAMES / H3_FPS,
                    max=MAX_H3_FRAMES / H3_FPS,
                    step=H3_FRAME_STEP / H3_FPS,
                    tooltip=(
                        "Duration in seconds. Steps follow valid H3 lengths; "
                        "typed values round up to a valid length when sampling.")),
                io.Combo.Input(
                    "transition_mode",
                    options=["motion context", "hard cut"],
                    default="motion context",
                    tooltip=(
                        "Motion Context continues from the prior latent context. "
                        "Hard Cut removes the repeated latent head; it is not a "
                        "pixel-space cut.")),
                io.Int.Input(
                    "video_context_length", default=22, min=5, max=56, step=17,
                    tooltip="Motion Context window. Supported values: 5, 22, 39, 56."),
                io.Int.Input(
                    "audio_context_length", default=24, min=0, max=240, step=1,
                    tooltip="Motion Context audio window; 24 is about one second at 24 fps."),
                io.Boolean.Input(
                    "enable_preview", default=True,
                    tooltip=(
                        "Off skips decoding the stage preview and blocks both "
                        "preview outputs, even if they are connected.")),
            ],
            outputs=[
                H3_EXTENSION_DATA.Output("extension_out"),
                io.Latent.Output("chain_latent"),
                io.Image.Output("preview_images"),
                io.Audio.Output("preview_audio"),
            ],
        )

    @classmethod
    def execute(cls, extension_in, model, references, prompt, seed,
                use_initial_duration, duration_s,
                transition_mode, video_context_length, audio_context_length,
                enable_preview):
        _validate_extension_data(extension_in)
        previous_latent = extension_in["latent"]
        if use_initial_duration:
            duration_s = extension_in["initial_duration_s"]
        conditioning, base_latent = _build_reference_conditioning(
            extension_in["clip"], references, prompt,
            extension_in["width"], extension_in["height"],
            _duration_to_h3_frames(duration_s),
            extension_in["ref_image_size"], extension_in["video_vae"],
            extension_in["audio_vae"])

        trim_frames = 0
        if transition_mode == "motion context":
            conditioning, base_latent, trim_frames = H3ExtensionBridge().bridge(
                previous_latent=previous_latent,
                conditioning=conditioning,
                latent=base_latent,
                video_vae=extension_in["video_vae"],
                context_length=str(video_context_length),
                audio_context_length=audio_context_length,
            )
        elif transition_mode == "hard cut":
            H3ExtensionLatentTrim.validate_compatible(base_latent, previous_latent)
            trim_frames = 5
        else:
            raise ValueError(
                "h3_extension_sampler: unsupported transition mode %r." % transition_mode)

        sampled_latent = _sample(
            model, conditioning, base_latent, seed,
            extension_in["sampler"], extension_in["sigmas"])
        chain_latent = H3ExtensionLatentTrim().trim_latent(
            sampled_latent,
            trim_frames,
            previous_latent,
            hard_cut=transition_mode == "hard cut",
        )[0]
        preview_images, preview_audio = _stage_preview(
            sampled_latent,
            extension_in["video_vae"],
            extension_in["audio_vae"],
            trim_frames,
            enable_preview,
        )
        next_extension_out = dict(extension_in)
        next_extension_out["latent"] = chain_latent
        return io.NodeOutput(
            next_extension_out, chain_latent, preview_images, preview_audio)
