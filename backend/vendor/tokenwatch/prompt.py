"""tokenwatch/prompt.py — Prompt optimization utilities."""

import re


def compress_system_prompt(original: str, max_tokens: int | None = None) -> str:
    """Apply basic compression heuristics to a system prompt."""
    compressed = original
    filler_phrases = [
        "You are an expert ", "You are a highly skilled ",
        "You have been trained on ", "Your job is to carefully ",
        "Please read carefully and ", "Think step by step about ",
        "Here are the ", "Please note that ",
        "It is important to ", "Make sure to ", "Keep in mind that ",
    ]
    for phrase in filler_phrases:
        compressed = compressed.replace(phrase, "")
    compressed = re.sub(r'\n{3,}', '\n\n', compressed)
    compressed = re.sub(r'  +', ' ', compressed)
    return compressed.strip()


def build_efficient_prompt(
    task: str, context: str = "", output_format: str = "",
    constraints: list[str] | None = None,
    examples: list[dict[str, str]] | None = None, max_examples: int = 3,
) -> str:
    """Build a token-efficient prompt from structured components."""
    parts = [task]
    if constraints:
        parts.append("Constraints: " + "; ".join(constraints))
    if output_format:
        parts.append(f"Output format: {output_format}")
    if examples:
        parts.append("Examples:")
        for ex in examples[:max_examples]:
            parts.append(f"Input: {ex['input']}\nOutput: {ex['output']}")
    if context:
        parts.append(f"Context: {context}")
    return "\n\n".join(parts)
