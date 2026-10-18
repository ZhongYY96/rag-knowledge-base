"""tokenwatch/context.py — Context window analysis and optimization."""

from dataclasses import dataclass
from tokenwatch.tokens import estimate_tokens, count_message_tokens
from tokenwatch.config import TokenwatchConfig

MODEL_CONTEXT_WINDOWS = {
    "claude-sonnet-4-20250514": 200_000,
    "claude-haiku-4-5-20250514": 200_000,
    "claude-opus-4-20250514": 200_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
}


@dataclass
class ContextAnalysis:
    """Analysis of context window utilization."""
    model: str
    max_context: int
    input_tokens: int
    reserved_output: int
    utilization_pct: float
    estimated_cost_usd: float
    wasted_context_tokens: int

    @property
    def efficiency_rating(self) -> str:
        if self.utilization_pct < 10:
            return "excellent"
        elif self.utilization_pct < 50:
            return "good"
        elif self.utilization_pct < 80:
            return "watch"
        else:
            return "danger"


def analyze_context(
    messages: list[dict], system: str = "",
    model: str = "claude-sonnet-4-20250514",
    reserved_output: int = 4096,
) -> ContextAnalysis:
    """Analyze context window utilization for a request."""
    token_breakdown = count_message_tokens(messages, system, model)
    input_tokens = token_breakdown["total_estimated"]
    max_context = MODEL_CONTEXT_WINDOWS.get(model, 128_000)
    utilization = (input_tokens + reserved_output) / max_context * 100
    system_tokens = token_breakdown["system_tokens"]
    wasted = system_tokens if system_tokens > input_tokens * 0.5 else 0
    config = TokenwatchConfig.from_yaml("pricing.yaml")
    cost = input_tokens * config.get_rate(model, "input") / 1_000_000  # from pricing.yaml

    return ContextAnalysis(
        model=model, max_context=max_context,
        input_tokens=input_tokens, reserved_output=reserved_output,
        utilization_pct=utilization, estimated_cost_usd=cost,
        wasted_context_tokens=wasted,
    )
