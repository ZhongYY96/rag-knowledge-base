"""tokenwatch/meter.py — Token metering and cost attribution."""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class UsageRecord:
    """A single metered LLM request with cost attribution."""
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    model: str = ""
    provider: str = ""
    feature: str = ""
    user_id: str = ""
    team: str = ""
    environment: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0
    thinking_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: float = 0.0
    is_batch: bool = False
    is_cache_hit: bool = False
    stop_reason: str = ""
    raw_usage: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "request_id": self.request_id, "timestamp": self.timestamp,
            "model": self.model, "provider": self.provider,
            "feature": self.feature, "user_id": self.user_id,
            "team": self.team, "environment": self.environment,
            "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
            "cache_creation_tokens": self.cache_creation_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "thinking_tokens": self.thinking_tokens,
            "cost_usd": self.cost_usd, "latency_ms": self.latency_ms,
            "is_batch": self.is_batch, "is_cache_hit": self.is_cache_hit,
            "stop_reason": self.stop_reason,
        }
