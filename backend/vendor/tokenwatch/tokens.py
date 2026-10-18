"""tokenwatch/tokens.py — Token counting and estimation."""

import tiktoken
from anthropic import Anthropic

_openai_encoding = tiktoken.get_encoding("cl100k_base")
_anthropic_client: Anthropic | None = None


def _get_anthropic_client() -> Anthropic:
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = Anthropic()
    return _anthropic_client


def count_tokens_openai(text: str) -> int:
    """Count tokens using OpenAI's tokenizer (cl100k_base)."""
    return len(_openai_encoding.encode(text))


def count_tokens_anthropic(
    text: str, model: str = "claude-sonnet-4-20250514",
) -> int:
    """Count tokens using Anthropic's token counting API."""
    client = _get_anthropic_client()
    result = client.messages.count_tokens(
        model=model,
        messages=[{"role": "user", "content": text}],
    )
    return result.input_tokens


def estimate_tokens(text: str) -> int:
    """Quick local estimate without API calls (~4 chars per token)."""
    return max(1, len(text) // 4)


def count_message_tokens(
    messages: list[dict], system: str = "",
    model: str = "claude-sonnet-4-20250514",
) -> dict[str, int]:
    """Count tokens for a complete message payload."""
    breakdown = {
        "system_tokens": estimate_tokens(system) if system else 0,
        "message_tokens": 0,
        "overhead_tokens": 0,
    }
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            breakdown["message_tokens"] += estimate_tokens(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "text" in block:
                    breakdown["message_tokens"] += estimate_tokens(block["text"])
    breakdown["overhead_tokens"] = len(messages) * 4
    breakdown["total_estimated"] = sum(breakdown.values())
    return breakdown
