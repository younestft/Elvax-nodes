import json
import math


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON field "{key}".')
        result[key] = value
    return result


def _load_json(text):
    value = json.loads(text, object_pairs_hook=_unique_object)
    json.dumps(value, allow_nan=False)
    return value


class PromptTemplateBuilder:
    SEARCH_ALIASES = ["elvax", "json prompt", "json builder", "prompt builder"]
    CATEGORY = "Elvax/text"
    DESCRIPTION = "Create reusable prompt templates with editable, reorderable fields and nested groups. Load or save templates as JSON files and output the enabled fields as Prompt JSON."
    FUNCTION = "build_json"
    RETURN_TYPES = ("STRING", "INT", "FLOAT")
    RETURN_NAMES = ("Prompt JSON", "video_count", "video_duration")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "fields_json": ("STRING", {"default": "[]", "multiline": True}),
                "video_count": ("STRING", {"default": ""}),
                "video_duration": ("STRING", {"default": ""}),
            }
        }

    def build_json(self, fields_json="[]", video_count="", video_duration=""):
        saved_fields = json.loads(fields_json or "[]")
        enabled = saved_fields.get("fixedEnabled", {}) if isinstance(saved_fields, dict) else {}
        count_text = str(video_count or "").strip() if enabled.get("video_count", True) else ""
        duration_text = str(video_duration or "").strip() if enabled.get("video_duration", True) else ""
        if enabled.get("video_count") is True and not count_text:
            count_text = "0"
        if enabled.get("video_duration") is True and not duration_text:
            duration_text = "0"
        if count_text and not count_text.isdecimal():
            raise ValueError("video_count must be a non-negative integer or blank.")
        try:
            count_value = int(count_text) if count_text else None
        except ValueError as error:
            raise ValueError("video_count must be a non-negative integer or blank.") from error
        if duration_text and (any(char not in "0123456789." for char in duration_text) or duration_text.count(".") > 1):
            raise ValueError("video_duration must be a non-negative decimal number or blank.")
        try:
            duration_value = float(duration_text) if duration_text else None
        except ValueError as error:
            raise ValueError("video_duration must be a non-negative decimal number or blank.") from error
        if duration_value is not None and not math.isfinite(duration_value):
            raise ValueError("video_duration must be a finite number or blank.")
        if enabled.get("video_count") is True and count_value <= 0:
            raise ValueError("Enabled video count must be greater than zero.")
        if enabled.get("video_duration") is True and duration_value <= 0:
            raise ValueError("Enabled video duration must be greater than zero.")
        if count_value == 0 and enabled.get("video_count") is not True:
            count_value = None
        if duration_value == 0 and enabled.get("video_duration") is not True:
            duration_value = None

        if isinstance(saved_fields, list):
            fields = saved_fields
            keys = {}
        elif isinstance(saved_fields, dict):
            fields = saved_fields.get("fields", [])
            keys = saved_fields.get("keys", {})
            if not isinstance(keys, dict):
                raise ValueError("Prompt Template Builder fixed field keys must be an object.")
        else:
            raise ValueError("Prompt Template Builder fields must be a list or builder state object.")
        if not isinstance(fields, list):
            raise ValueError("Prompt Template Builder fields must be a list.")

        count_key = str(keys.get("video_count", "video_count")).strip() or "video_count"
        duration_key = str(keys.get("video_duration", "video_duration")).strip() or "video_duration"
        if count_key == duration_key:
            raise ValueError("The two fixed fields must have different names.")
        result = {}
        if count_value is not None:
            result[count_key] = count_value
        if duration_value is not None:
            result[duration_key] = duration_value
        for key, value in self._build_object(fields, "root").items():
            if key in (count_key, duration_key):
                raise ValueError(f'Field "{key}" conflicts with a fixed field. Rename it.')
            result[key] = value
        return json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), count_value, duration_value

    def _build_object(self, fields, path):
        result = {}
        for field in fields:
            if not isinstance(field, dict):
                raise ValueError("Each Prompt Template Builder field must be an object.")
            if field.get("hidden"):
                continue
            key = str(field.get("key", "")).strip()
            if not key:
                continue
            if key in result:
                raise ValueError(f'Duplicate field "{path}.{key}". Rename one of these fields.')
            kind = field.get("type", "string")
            result[key] = self._build_value(kind, field.get("value", ""), f"{path}.{key}")
        return result

    def _build_value(self, kind, value, path):
        if kind == "number":
            value = _load_json(str(value))
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f'Field "{path}" must contain a number.')
            return value
        if kind == "boolean":
            return value is True or str(value).lower() == "true"
        if kind == "json":
            try:
                return _load_json(value)
            except (TypeError, json.JSONDecodeError) as error:
                raise ValueError(f'Field "{path}" contains invalid JSON: {error}') from error
        if kind == "object":
            if not isinstance(value, list):
                raise ValueError(f'Object field "{path}" has invalid child fields.')
            return self._build_object(value, path)
        if kind == "array":
            if not isinstance(value, list):
                raise ValueError(f'Array field "{path}" has invalid items.')
            return [
                self._build_value(item.get("type", "string"), item.get("value", ""), f"{path}[{index}]")
                for index, item in enumerate(value, start=1)
                if not item.get("hidden")
            ]
        return str(value)
