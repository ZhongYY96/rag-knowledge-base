"""tokenwatch/client.py — Metered LLM client wrappers."""

import time
from typing import Any
import anthropic
from tokenwatch.config import TokenwatchConfig
from tokenwatch.middleware import TokenMeter
from tokenwatch.store import UsageStore


class MeteredAnthropic:
    """Anthropic client with automatic token metering."""

    def __init__(self, meter: TokenMeter, client: anthropic.Anthropic | None = None):
        self.client = client or anthropic.Anthropic()
        self.meter = meter

    def create_message(
        self, feature: str = "", user_id: str = "", team: str = "",
        **kwargs: Any,
    ) -> tuple[anthropic.types.Message, Any]:
        start = time.monotonic()
        response = self.client.messages.create(**kwargs)
        latency_ms = (time.monotonic() - start) * 1000
        record = self.meter.measure_anthropic(
            response=response, latency_ms=latency_ms,
            feature=feature, user_id=user_id, team=team,
        )
        return response, record
