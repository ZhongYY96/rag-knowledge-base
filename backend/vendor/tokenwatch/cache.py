"""tokenwatch/cache.py — Prompt caching utilities and monitoring."""

from dataclasses import dataclass
from typing import Any
import anthropic
from tokenwatch.config import TokenwatchConfig


@dataclass
class CacheMetrics:
    total_requests: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    cache_writes: int = 0
    tokens_cached_read: int = 0
    tokens_cached_write: int = 0
    estimated_savings_usd: float = 0.0

    @property
    def hit_rate(self) -> float:
        return self.cache_hits / self.total_requests if self.total_requests else 0.0


class CacheOptimizer:
    def __init__(self, config: TokenwatchConfig):
        self.config = config
        self.metrics = CacheMetrics()

    def build_cached_messages(
        self, system_prompt: str, tool_definitions: list[dict] | None = None,
        static_context: str = "", user_message: str = "",
        conversation_history: list[dict] | None = None,
    ) -> dict[str, Any]:
        system_parts = [{"type": "text", "text": system_prompt}]
        if static_context:
            system_parts.append({
                "type": "text", "text": static_context,
                "cache_control": {"type": "ephemeral"},
            })
        else:
            system_parts[-1]["cache_control"] = {"type": "ephemeral"}
        messages = list(conversation_history or [])
        if user_message:
            messages.append({"role": "user", "content": user_message})
        result = {"system": system_parts, "messages": messages}
        if tool_definitions:
            result["tools"] = tool_definitions
        return result

    def track_cache_result(self, response: anthropic.types.Message, model: str) -> dict:
        usage = response.usage
        cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
        cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
        self.metrics.total_requests += 1
        if cache_read > 0:
            self.metrics.cache_hits += 1
            self.metrics.tokens_cached_read += cache_read
        elif cache_write > 0:
            self.metrics.cache_writes += 1
        pricing = self.config.get_model(model)
        savings = (cache_read / 1_000_000) * (pricing.input_rate - pricing.cached_rate)
        self.metrics.estimated_savings_usd += savings
        return {"cache_hit": cache_read > 0, "savings_this_request": savings, "hit_rate": self.metrics.hit_rate}
