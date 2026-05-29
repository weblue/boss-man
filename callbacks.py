from typing import Literal, Optional, Union

from litellm.caching.caching import DualCache
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

# Add model aliases here if any boss-man routes ever point at OpenAI Responses API.
OPENAI_RESPONSES_ALIASES: set[str] = set()

UNSUPPORTED_OLLAMA_REASONING_KEYS = ("thinking", "reasoning", "reasoning_effort")


class BossManCallbacks(CustomLogger):
    def _uses_openai_responses(self, model: str, data: dict) -> bool:
        if model.startswith("chatgpt/"):
            return True

        metadata = data.get("metadata") or {}
        if isinstance(metadata, dict) and metadata.get("route_family") == "openai-responses":
            return True

        model_info = data.get("model_info") or {}
        if isinstance(model_info, dict) and model_info.get("route_family") == "openai-responses":
            return True

        return model in OPENAI_RESPONSES_ALIASES

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: Literal[
            "completion",
            "text_completion",
            "embeddings",
            "image_generation",
            "moderation",
            "audio_transcription",
            "pass_through_endpoint",
            "rerank",
            "mcp_call",
            "anthropic_messages",
        ],
    ) -> Optional[Union[Exception, str, dict]]:
        model = data.get("model", "")

        # Strip unsupported reasoning fields for local Ollama models
        if model == "local-worker" or model.startswith(("ollama/", "ollama_chat/")):
            for key in UNSUPPORTED_OLLAMA_REASONING_KEYS:
                data.pop(key, None)
            extra_body = data.get("extra_body")
            if isinstance(extra_body, dict):
                for key in UNSUPPORTED_OLLAMA_REASONING_KEYS:
                    extra_body.pop(key, None)

        if self._uses_openai_responses(model, data):
            # Translate system prompts to developer role for OpenAI Responses routes
            system_content = data.pop("system", None)
            if system_content:
                dev_msg = {"role": "developer", "content": system_content}
                messages = data.get("messages", [])
                messages.insert(0, dev_msg)
                data["messages"] = messages

            for key in ("messages", "input"):
                items = data.get(key)
                if isinstance(items, list):
                    for msg in items:
                        if isinstance(msg, dict) and msg.get("role") == "system":
                            msg["role"] = "developer"

        return data


proxy_handler_instance = BossManCallbacks()
