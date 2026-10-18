"""tokenwatch/router.py — Model routing and quality cascades."""

from dataclasses import dataclass
from enum import Enum


class Complexity(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class RoutingDecision:
    model: str
    complexity: Complexity
    reason: str
    estimated_cost_ratio: float


@dataclass
class ModelTier:
    model_id: str
    max_complexity: Complexity
    cost_ratio: float
    description: str


@dataclass
class RoutingPolicy:
    tiers: list[ModelTier]
    default_tier: int = 0

    @classmethod
    def anthropic_cascade(cls) -> "RoutingPolicy":
        return cls(tiers=[
            ModelTier("claude-haiku-4-5-20250514", Complexity.LOW, 0.15, "Fast, cheap"),
            ModelTier("claude-sonnet-4-20250514", Complexity.HIGH, 0.40, "Balanced"),
            ModelTier("claude-opus-4-20250514", Complexity.CRITICAL, 1.0, "Most capable"),
        ])
