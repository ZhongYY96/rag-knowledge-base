"""请求/响应模型。"""
from pydantic import BaseModel, Field


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    thinking_tokens: int = 0


class Timings(BaseModel):
    retrieval_ms: int | None = None
    ttft_ms: int | None = None
    latency_ms: int | None = None


class CallIn(BaseModel):
    request_id: str = Field(description="幂等键，客户端生成 UUID")
    tenant_id: str
    feature: str = "chat.answer"
    model: str
    usage: Usage = Usage()
    timings: Timings = Timings()
    status: str = "ok"
    meta: dict = {}
    ts: str | None = Field(default=None, description="ISO8601，缺省用服务器时间")


class PreflightIn(BaseModel):
    tenant_id: str
    feature: str = "chat.answer"
    model: str
    prompt_text: str | None = None
    est_prompt_tokens: int | None = None
    max_tokens: int = 512


class BudgetIn(BaseModel):
    tenant_id: str
    period: str = "daily"
    limit_micro_usd: int = 1_000_000      # 默认 1 美元/天
    action: str = "WARN"                  # WARN / THROTTLE / DOWNGRADE / BLOCK
    warn_at_pct: float = 80.0
