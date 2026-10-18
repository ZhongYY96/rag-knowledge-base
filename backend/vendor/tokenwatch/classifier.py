"""tokenwatch/classifier.py — Request complexity classification."""

import re
from tokenwatch.router import Complexity


def classify_by_rules(
    messages: list[dict], system: str = "",
    tool_count: int = 0, history_turns: int = 0,
) -> Complexity:
    user_msg = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            user_msg = content if isinstance(content, str) else str(content)
            break
    msg_length = len(user_msg)
    if msg_length < 100 and tool_count == 0 and history_turns < 3:
        return Complexity.LOW
    complex_patterns = [
        r"\b(analyze|compare|evaluate|explain why|reason)\b",
        r"\b(step by step|think through|consider)\b",
    ]
    has_complex = any(re.search(p, user_msg, re.IGNORECASE) for p in complex_patterns)
    if tool_count > 5:
        return Complexity.HIGH if has_complex else Complexity.MEDIUM
    if msg_length > 500 and has_complex:
        return Complexity.HIGH
    if msg_length > 200 or has_complex:
        return Complexity.MEDIUM
    return Complexity.LOW


def classify_by_feature(feature: str, feature_map: dict[str, Complexity] | None = None) -> Complexity:
    default_map = {
        "ticket-classifier": Complexity.LOW,
        "faq-bot": Complexity.LOW,
        "chat-agent": Complexity.MEDIUM,
        "code-review": Complexity.HIGH,
    }
    return (feature_map or default_map).get(feature, Complexity.MEDIUM)
