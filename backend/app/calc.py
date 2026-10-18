"""成本计算：复用 vendor/tokenwatch 的计价模型。

关键点：
  · 价格来自 TokenwatchConfig（Packt 的 ModelPricing）
  · 对外统一用「微美元整数」，避免浮点累加误差
"""
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND / "vendor") not in sys.path:
    sys.path.insert(0, str(_BACKEND / "vendor"))

from tokenwatch.config import TokenwatchConfig  # noqa: E402  复用 Packt 实现

from .settings import PRICING_PATH

_config: TokenwatchConfig | None = None


def config() -> TokenwatchConfig:
    global _config
    if _config is None:
        _config = TokenwatchConfig.from_yaml(PRICING_PATH)
    return _config


def cost_micro_usd(
    model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    cached_tokens: int = 0,
    thinking_tokens: int = 0,
    batch: bool = False,
) -> int:
    """一次调用的成本（微美元）。未知模型按 0 计，并在 meta 里标注。"""
    try:
        pricing = config().get_model(model)
    except KeyError:
        return 0

    usd = pricing.cost_for_tokens(
        input_tokens=prompt_tokens,
        output_tokens=completion_tokens,
        cached_tokens=cached_tokens,
        thinking_tokens=thinking_tokens,
        batch=batch,
    )
    return int(round(usd * 1_000_000))


def estimate_tokens(text: str) -> int:
    """粗略估算 token：CJK 按 1 字≈0.6 token，其余按 4 字符≈1 token。

    没接 tiktoken 是有意的：本地模型的分词器与 cl100k_base 不同，
    精确计数意义不大，预检阶段只需要量级准确。
    """
    if not text:
        return 0
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = len(text) - cjk
    return int(round(cjk * 0.6 + other / 4)) + 8


def estimate_cost_range(model: str, prompt_tokens: int, max_tokens: int) -> tuple[int, int]:
    """预检用：给出最小/最大成本（微美元）。"""
    min_out = max(16, max_tokens // 10)
    return (
        cost_micro_usd(model, prompt_tokens=prompt_tokens, completion_tokens=min_out),
        cost_micro_usd(model, prompt_tokens=prompt_tokens, completion_tokens=max_tokens),
    )
