"""tokenwatch/history.py — Conversation history management."""

from tokenwatch.tokens import estimate_tokens


def truncate_history(
    messages: list[dict], max_tokens: int = 4000,
    keep_system: bool = True, keep_last_n: int = 4,
    summarize_fn=None,
) -> list[dict]:
    """Truncate conversation history to fit within a token budget."""
    if not messages:
        return messages
    system_msgs = [m for m in messages if m.get("role") == "system"]
    conv_msgs = [m for m in messages if m.get("role") != "system"]
    recent = conv_msgs[-keep_last_n:] if len(conv_msgs) > keep_last_n else conv_msgs
    older = conv_msgs[:-keep_last_n] if len(conv_msgs) > keep_last_n else []

    required_tokens = sum(
        estimate_tokens(m.get("content", "")) for m in (system_msgs + recent)
    )
    if required_tokens >= max_tokens:
        result = system_msgs if keep_system else []
        remaining = max_tokens - sum(estimate_tokens(m.get("content", "")) for m in result)
        for msg in reversed(recent):
            msg_tokens = estimate_tokens(msg.get("content", ""))
            if remaining >= msg_tokens:
                result.append(msg)
                remaining -= msg_tokens
        return result

    remaining_budget = max_tokens - required_tokens
    kept_older = []
    for msg in reversed(older):
        msg_tokens = estimate_tokens(msg.get("content", ""))
        if remaining_budget >= msg_tokens:
            kept_older.insert(0, msg)
            remaining_budget -= msg_tokens
        else:
            break

    dropped = older[:len(older) - len(kept_older)]
    if dropped and summarize_fn:
        summary_text = summarize_fn(dropped)
        summary_msg = {"role": "user", "content": f"[Summary: {summary_text}]"}
        return system_msgs + [summary_msg] + kept_older + recent

    return system_msgs + kept_older + recent
