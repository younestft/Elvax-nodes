import importlib.util
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest


MODULE_PATH = Path(__file__).parents[1] / "lm_studio_prompt_enhancer.py"
SPEC = importlib.util.spec_from_file_location("elvax_lm_studio_prompt_enhancer", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeStream:
    def __init__(self, fragments):
        self.fragments = fragments

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def __iter__(self):
        return iter(self.fragments)

    def result(self):
        return SimpleNamespace(content="raw response")

    def cancel(self):
        pass


class FakeModel:
    def __init__(self, fragments):
        self.fragments = fragments
        self.config = None
        self.unloaded = False

    def respond_stream(self, chat, config):
        self.config = config
        return FakeStream(self.fragments)

    def unload(self):
        self.unloaded = True

    def get_info(self):
        return SimpleNamespace(model_key="chosen-model")


class BlockingModel(FakeModel):
    def __init__(self):
        super().__init__([])
        self.stream = BlockingStream()

    def respond_stream(self, chat, config):
        self.config = config
        return self.stream


class BlockingStream(FakeStream):
    def __init__(self):
        super().__init__([])
        self.cancelled = threading.Event()

    def __iter__(self):
        self.cancelled.wait(1)
        raise RuntimeError("cancelled")

    def cancel(self):
        self.cancelled.set()


class ThinkingRemovalTests(unittest.TestCase):
    def test_removes_thinking_variants(self):
        cases = (
            ("<think>reasoning</think>\nFINAL", "FINAL"),
            ("<thinking>reasoning</thinking>\nFINAL", "FINAL"),
            ("<THINK>line 1\nline 2</THINK>\nFINAL", "FINAL"),
            ("unfinished reasoning</think>FINAL", "FINAL"),
            ("unfinished reasoning</thinking>FINAL", "FINAL"),
            ("FINAL", "FINAL"),
        )
        for source, expected in cases:
            with self.subTest(source=source):
                self.assertEqual(MODULE.strip_thinking_tags(source), expected)

    def test_excludes_reasoning_fragments_and_cleans_literal_tags(self):
        fragments = [
            SimpleNamespace(content="secret", reasoning_type="reasoning"),
            SimpleNamespace(content="<think>embedded</think>FINAL", reasoning_type="none"),
        ]
        _, text = MODULE._collect_response(FakeModel(fragments), object(), {}, 300)
        self.assertEqual(text, "FINAL")

    def test_timeout_cancels_the_lm_studio_stream(self):
        stream = BlockingStream()
        model = SimpleNamespace(respond_stream=lambda chat, config: stream)
        with self.assertRaises(MODULE._GenerationTimedOut):
            MODULE._collect_response(model, object(), {}, 0.01)
        self.assertTrue(stream.cancelled.is_set())


class NodeContractTests(unittest.TestCase):
    def test_inputs_defaults_tooltips_and_hidden_settings(self):
        inputs = MODULE.LMStudioPromptEnhancer.INPUT_TYPES()["required"]
        self.assertEqual(
            list(inputs),
            [
                "prompt",
                "system_prompt",
                "model_key",
                "auto_unload",
                "seed",
                "max_tokens",
                "temperature",
                "top_k",
                "top_p",
                "timeout_seconds",
            ],
        )
        self.assertEqual(inputs["model_key"][1]["default"], "")
        self.assertEqual(inputs["seed"][1]["default"], 0)
        self.assertEqual(inputs["seed"][1]["control_after_generate"], "fixed")
        self.assertEqual(inputs["max_tokens"][1]["default"], 1500)
        self.assertEqual(inputs["temperature"][1]["default"], 0.7)
        self.assertEqual(inputs["top_k"][1]["default"], 20)
        self.assertEqual(inputs["top_p"][1]["default"], 0.8)
        self.assertEqual(inputs["timeout_seconds"][1]["default"], 300)
        for hidden in ("unload_delay", "debug", "strip_thinking", "model", "ip_address", "port"):
            self.assertNotIn(hidden, inputs)
        for name in ("model_key", "temperature", "top_k", "top_p"):
            self.assertIn("Default value:", inputs[name][1]["tooltip"])

    def test_generation_config_and_immediate_unload(self):
        model = FakeModel([SimpleNamespace(content="FINAL", reasoning_type="none")])

        class FakeLlm:
            def model(self, model_key=None):
                self.model_key = model_key
                return model

            def list_loaded(self):
                return [model]

        fake_llm = FakeLlm()

        class FakeClient:
            llm = fake_llm

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

        class FakeChat:
            def __init__(self, system_prompt):
                self.system_prompt = system_prompt

            def add_user_message(self, prompt):
                self.prompt = prompt

        original_lms = MODULE.lms
        MODULE.lms = SimpleNamespace(Client=FakeClient, Chat=FakeChat)
        try:
            output = MODULE.LMStudioPromptEnhancer().generate_text(
                "prompt", "system", "chosen-model", "True", 0, 1000, 0.7, 20, 0.8, 300
            )
            self.assertTrue(model.unloaded)
            model.unloaded = False
            MODULE.LMStudioPromptEnhancer().generate_text(
                "prompt", "system", "chosen-model", "False", 0, 1000, 0.7, 20, 0.8, 300
            )
            self.assertFalse(model.unloaded)
        finally:
            MODULE.lms = original_lms

        self.assertEqual(output, ("FINAL",))
        self.assertEqual(fake_llm.model_key, "chosen-model")
        self.assertEqual(
            model.config,
            {
                "maxTokens": 1000,
                "temperature": 0.7,
                "seed": 0,
                "topKSampling": 20,
                "topPSampling": 0.8,
            },
        )

    def test_timeout_cancels_stream_and_unloads_model(self):
        model = BlockingModel()

        class FakeLlm:
            def model(self, model_key=None):
                return model

            def list_loaded(self):
                return [model]

        class FakeClient:
            llm = FakeLlm()

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

        class FakeChat:
            def __init__(self, system_prompt):
                pass

            def add_user_message(self, prompt):
                pass

        original_lms = MODULE.lms
        MODULE.lms = SimpleNamespace(Client=FakeClient, Chat=FakeChat)
        try:
            output = MODULE.LMStudioPromptEnhancer().generate_text(
                "prompt", "system", "chosen-model", "True", 0, 1000, 0.7, 20, 0.8, 0.01
            )
        finally:
            MODULE.lms = original_lms

        self.assertEqual(output, ("Error: LM Studio operation timed out after 0.01 seconds.",))
        self.assertTrue(model.stream.cancelled.is_set())
        self.assertTrue(model.unloaded)

    def test_empty_model_key_remembers_loaded_model_after_unload(self):
        model = FakeModel([SimpleNamespace(content="FINAL", reasoning_type="none")])

        class FakeLlm:
            def __init__(self):
                self.loaded = [model]
                self.requested_keys = []

            def list_loaded(self):
                return self.loaded

            def model(self, model_key=None):
                self.requested_keys.append(model_key)
                return model

        fake_llm = FakeLlm()
        node = MODULE.LMStudioPromptEnhancer()
        first = node._get_model(SimpleNamespace(llm=fake_llm), "")
        fake_llm.loaded = []
        second = node._get_model(SimpleNamespace(llm=fake_llm), "")

        self.assertIs(first, model)
        self.assertIs(second, model)
        self.assertEqual(fake_llm.requested_keys, ["chosen-model"])

    def test_context_overflow_error_tells_user_to_increase_context(self):
        message = MODULE._generation_error_message(
            RuntimeError(
                'request exceeds the available context size: {"type":"exceed_context_size_error"}'
            )
        )
        self.assertIn("Increase the model context size in LM Studio", message)


if __name__ == "__main__":
    unittest.main()
