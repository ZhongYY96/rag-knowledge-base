"""tokenwatch/middleware.py — Metering middleware for LLM API calls."""

import time
from typing import Any
import anthropic
from tokenwatch.config import TokenwatchConfig
from tokenwatch.meter import UsageRecord
from tokenwatch.store import UsageStore


class TokenMeter:
    """Metering middleware for LLM API calls."""

    def __init__(
        self, config: TokenwatchConfig, store: UsageStore | None = None,
        default_feature: str = "unknown", default_team: str = "unknown",
        environment: str = "development",
    ):
        self.config = config
        self.store = store or UsageStore()
        self.default_feature = default_feature
        self.default_team = default_team
        self.environment = environment

    def measure_anthropic(
        self, response: anthropic.types.Message, latency_ms: float,
        feature: str | None = None, user_id: str = "", team: str | None = None,
    ) -> UsageRecord:
        usage = response.usage
        model = response.model
        cache_creation = getattr(usage, "cache_creation_input_tokens", 0) or 0
        cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
        input_tokens = usage.input_tokens - cache_read
        pricing = self.config.get_model(model)
        cost = pricing.cost_for_tokens(
            input_tokens=input_tokens, output_tokens=usage.output_tokens,
            cached_tokens=cache_read,
        )
        record = UsageRecord(
            model=model, provider="anthropic",
            feature=feature or self.default_feature,
            user_id=user_id, team=team or self.default_team,
            environment=self.environment,
            input_tokens=input_tokens, output_tokens=usage.output_tokens,
            cache_creation_tokens=cache_creation, cache_read_tokens=cache_read,
            cost_usd=cost, latency_ms=latency_ms,
            is_cache_hit=cache_read > 0,
            stop_reason=response.stop_reason or "",
        )
        self.store.record(record)
        return record
