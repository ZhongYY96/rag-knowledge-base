"""tokenwatch/preflight.py — Pre-request cost estimation."""

from dataclasses import dataclass
from tokenwatch.config import TokenwatchConfig
from tokenwatch.tokens import estimate_tokens


@dataclass
class PreflightEstimate:
    """Cost estimate before sending a request."""
    model: str
    estimated_input_tokens: int
    max_output_tokens: int
    estimated_cost_min: float
    estimated_cost_max: float
    recommendation: str


def preflight_check(
    config: TokenwatchConfig, model: str, system: str,
    messages: list[dict], max_tokens: int = 4096,
    thinking_budget: int = 0,
) -> PreflightEstimate:
    """Estimate cost before sending an API request."""
    pricing = config.get_model(model)
    input_tokens = estimate_tokens(system)
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            input_tokens += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    input_tokens += estimate_tokens(block["text"])
    input_tokens += len(messages) * 4

    min_output = max(10, max_tokens // 10)
    cost_min = pricing.cost_for_tokens(
        input_tokens=input_tokens, output_tokens=min_output,
        thinking_tokens=thinking_budget // 2,
    )
    cost_max = pricing.cost_for_tokens(
        input_tokens=input_tokens, output_tokens=max_tokens,
        thinking_tokens=thinking_budget,
    )

    if cost_max > config.budget_hard_limit_usd:
        recommendation = "BLOCK: estimated cost exceeds hard limit"
    elif cost_max > config.budget_alert_threshold_usd:
        recommendation = "WARN: estimated cost exceeds alert threshold"
    elif input_tokens > 50_000:
        recommendation = "REVIEW: large context — consider truncation or RAG"
    else:
        recommendation = "OK"

    return PreflightEstimate(
        model=model, estimated_input_tokens=input_tokens,
        max_output_tokens=max_tokens,
        estimated_cost_min=cost_min, estimated_cost_max=cost_max,
        recommendation=recommendation,
    )
