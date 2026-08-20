import re
import threading

try:
    import lmstudio as lms
except ImportError:
    lms = None


_THINK_BLOCK_RE = re.compile(
    r"<thinking>.*?</thinking>|<think>.*?</think>",
    flags=re.DOTALL | re.IGNORECASE,
)
_LONE_THINK_END_RE = re.compile(
    r"^.*?</(?:think|thinking)>",
    flags=re.DOTALL | re.IGNORECASE,
)


class _GenerationTimedOut(TimeoutError):
    pass


def strip_thinking_tags(text):
    text = _THINK_BLOCK_RE.sub("", text)
    text = _LONE_THINK_END_RE.sub("", text)
    return text.strip()


def _collect_response(model, chat, config, timeout_seconds):
    content_parts = []
    with model.respond_stream(chat, config=config) as stream:
        timed_out = threading.Event()
        state_lock = threading.Lock()
        finished = False

        def cancel_stream():
            nonlocal finished
            with state_lock:
                if finished:
                    return
                timed_out.set()
            stream.cancel()

        timer = threading.Timer(timeout_seconds, cancel_stream)
        timer.daemon = True
        timer.start()
        try:
            for fragment in stream:
                if getattr(fragment, "reasoning_type", None) in (None, "none"):
                    content_parts.append(fragment.content)
            result = stream.result()
            with state_lock:
                finished = True
        except Exception as error:
            if timed_out.is_set():
                raise _GenerationTimedOut from error
            raise
        finally:
            timer.cancel()

        if timed_out.is_set():
            raise _GenerationTimedOut

    return result, strip_thinking_tags("".join(content_parts))


class LMStudioPromptEnhancer:
    def __init__(self):
        self._last_model_key = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"default": ""}),
                "system_prompt": ("STRING", {"default": ""}),
                "model_key": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Keep empty to use an already loaded LM Studio model. The node remembers that model for later runs. Default value: empty.",
                    },
                ),
                "auto_unload": (["True", "False"], {"default": "True"}),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": "fixed",
                    },
                ),
                "max_tokens": ("INT", {"default": 1500, "min": 1, "max": 4096}),
                "temperature": (
                    "FLOAT",
                    {
                        "default": 0.7,
                        "min": 0.0,
                        "max": 2.0,
                        "step": 0.05,
                        "tooltip": "The higher the value, the more creative and adventurous the output. Default value: 0.7.",
                    },
                ),
                "top_k": (
                    "INT",
                    {
                        "default": 20,
                        "min": 0,
                        "max": 1000,
                        "step": 1,
                        "tooltip": "Hard limit on the vocabulary bag. Default value: 20.",
                    },
                ),
                "top_p": (
                    "FLOAT",
                    {
                        "default": 0.8,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "How big a vocabulary bag of possible next words the model can choose from. Lower values use a smaller, safer vocabulary bag; higher values use a bigger, more varied vocabulary bag. Default value: 0.8.",
                    },
                ),
                "timeout_seconds": (
                    "INT",
                    {"default": 300, "min": 10, "max": 3600, "step": 1},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Generated Text",)
    FUNCTION = "generate_text"
    CATEGORY = "Elvax"

    def _get_model(self, client, model_key):
        model_key = str(model_key).strip()
        if model_key:
            self._last_model_key = model_key
            return client.llm.model(model_key)

        loaded_models = client.llm.list_loaded()
        if loaded_models:
            model = loaded_models[0]
            self._last_model_key = model.get_info().model_key
            return model

        if self._last_model_key:
            return client.llm.model(self._last_model_key)

        raise RuntimeError(
            "No LM Studio model is loaded. Load a model in LM Studio or enter its model key."
        )

    def generate_text(
        self,
        prompt,
        system_prompt,
        model_key,
        auto_unload,
        seed,
        max_tokens,
        temperature,
        top_k,
        top_p,
        timeout_seconds,
    ):
        if lms is None:
            raise RuntimeError(
                "LM Studio SDK (lmstudio) is not installed. Install the Elvax-nodes requirements and restart ComfyUI."
            )

        should_unload = auto_unload is True or str(auto_unload).lower() == "true"

        def generate():
            try:
                with lms.Client() as client:
                    model = self._get_model(client, model_key)
                    try:
                        chat = lms.Chat(system_prompt)
                        chat.add_user_message(prompt)
                        config = {
                            "maxTokens": max_tokens,
                            "temperature": temperature,
                            "seed": seed,
                            "topKSampling": top_k,
                            "topPSampling": top_p,
                        }
                        _, output_text = _collect_response(
                            model, chat, config, timeout_seconds
                        )
                        return (output_text,)
                    finally:
                        if should_unload:
                            try:
                                model.unload()
                            except Exception as error:
                                print(f"[Elvax] Warning: Failed to unload LM Studio model: {error}")
            except _GenerationTimedOut:
                return (f"Error: LM Studio operation timed out after {timeout_seconds} seconds.",)
            except Exception as error:
                raise RuntimeError(
                    "LM Studio generation failed. Make sure LM Studio is open and its local server is enabled. "
                    f"({error})"
                ) from error

        return generate()
