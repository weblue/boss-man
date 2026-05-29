from typing import Literal, Optional, Union

from litellm.caching.caching import DualCache
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

UNSUPPORTED_OLLAMA_REASONING_KEYS = ("thinking", "reasoning", "reasoning_effort")


class BossManCallbacks(CustomLogger):
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

        return data


proxy_handler_instance = BossManCallbacks()
