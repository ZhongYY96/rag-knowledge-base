"""成本评估与治理服务。

    uvicorn app.main:app --port 8100

设计要点见 backend/README.md：
  · 全部对外接口只给服务端用（X-Internal-Token）
  · 预检 fail-open：本服务不可用时不能拖垮问答
  · 计价、存储、裁决分层，各自可替换
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND / "vendor") not in sys.path:
    sys.path.insert(0, str(_BACKEND / "vendor"))

from . import calc, policy, repo  # noqa: E402
from .schemas import BudgetIn, CallIn, PreflightIn  # noqa: E402
from .settings import INTERNAL_TOKEN  # noqa: E402

app = FastAPI(title="RAG Cost & Governance Service", version="0.1.0")


@app.on_event("startup")
def _startup() -> None:
    repo.init_db()


def auth(x_internal_token: str | None = Header(default=None)) -> None:
    if x_internal_token != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal token")


def _since(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "db": str(repo.DB_PATH)}


@app.post("/v1/calls", dependencies=[Depends(auth)], status_code=202)
def record_call(body: CallIn) -> dict:
    """记录一次调用。request_id 幂等：重复上报只计一次。"""
    cost = calc.cost_micro_usd(
        body.model,
        prompt_tokens=body.usage.prompt_tokens,
        completion_tokens=body.usage.completion_tokens,
        cached_tokens=body.usage.cached_tokens,
        thinking_tokens=body.usage.thinking_tokens,
    )
    rec = {
        "id": body.request_id,
        "ts": body.ts or datetime.now(timezone.utc).isoformat(),
        "tenant_id": body.tenant_id,
        "feature": body.feature,
        "model": body.model,
        "prompt_tokens": body.usage.prompt_tokens,
        "completion_tokens": body.usage.completion_tokens,
        "cached_tokens": body.usage.cached_tokens,
        "cost_micro_usd": cost,
        "retrieval_ms": body.timings.retrieval_ms,
        "ttft_ms": body.timings.ttft_ms,
        "latency_ms": body.timings.latency_ms,
        "status": body.status,
        "meta": body.meta,
    }
    inserted = repo.insert_call(rec)
    return {"recorded": inserted, "duplicate": not inserted, "cost_micro_usd": cost}


@app.post("/v1/preflight", dependencies=[Depends(auth)])
def preflight(body: PreflightIn) -> dict:
    """调用前预检：估算成本 + 查预算，返回动作。

    客户端拿到 action 后自行执行（换模型 / 限速 / 拒绝），服务端不拦截请求。
    """
    prompt_tokens = body.est_prompt_tokens
    if prompt_tokens is None:
        prompt_tokens = calc.estimate_tokens(body.prompt_text or "")

    min_micro, max_micro = calc.estimate_cost_range(body.model, prompt_tokens, body.max_tokens)
    result = policy.evaluate(body.tenant_id, body.feature, max_micro)

    return {
        "action": result.action.name,
        "allowed": result.allowed,
        "reason": result.message,
        "budget": result.budget_name,
        "utilization_pct": round(result.utilization_pct, 1),
        "remaining_micro_usd": None if result.remaining_usd == float("inf") else int(result.remaining_usd * 1_000_000),
        "estimated_micro_usd": {"min": min_micro, "max": max_micro},
        "suggested_model": result.downgrade_model,
    }


@app.get("/v1/summary", dependencies=[Depends(auth)])
def summary(tenant_id: str, days: int = 7) -> dict:
    data = repo.summary(tenant_id, _since(days))
    return {"tenant_id": tenant_id, "days": days, **data}


@app.get("/v1/calls", dependencies=[Depends(auth)])
def calls(tenant_id: str, days: int = 7, limit: int = 50) -> dict:
    return {"items": repo.list_calls(tenant_id, _since(days), min(limit, 500))}


@app.get("/v1/budgets", dependencies=[Depends(auth)])
def get_budgets(tenant_id: str) -> dict:
    return {"items": repo.get_budgets(tenant_id)}


@app.put("/v1/budgets", dependencies=[Depends(auth)])
def put_budget(body: BudgetIn) -> dict:
    if body.action.upper() not in {"WARN", "THROTTLE", "DOWNGRADE", "BLOCK"}:
        raise HTTPException(status_code=400, detail="action 只能是 WARN/THROTTLE/DOWNGRADE/BLOCK")
    return repo.upsert_budget(
        body.tenant_id, body.period, body.limit_micro_usd, body.action, body.warn_at_pct
    )
