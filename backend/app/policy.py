"""预算裁决：复用 vendor/tokenwatch 的 Budget / BudgetAction / BudgetCheckResult。

与 Packt 原实现的差别只有一处：
  原实现把 current_spend 存在内存里（BudgetManager._refresh_budgets 从 store 反射），
  这里改成每次从 SQLite 现算——多进程/多实例下不会各算各的。
"""
from datetime import datetime, timedelta, timezone

from tokenwatch.governance import Budget, BudgetAction, BudgetCheckResult  # 复用

from . import repo
from .settings import DOWNGRADE_TARGET


def _period_start(period: str) -> datetime:
    now = datetime.now(timezone.utc)
    p = (period or "daily").lower()
    if p in ("daily", "day"):
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _spend_usd(tenant_id: str, period: str) -> float:
    since = _period_start(period).isoformat()
    return repo.spend_micro(tenant_id, since) / 1_000_000


def evaluate(tenant_id: str, feature: str, estimated_micro_usd: int) -> BudgetCheckResult:
    rows = repo.get_budgets(tenant_id)
    if not rows:
        return BudgetCheckResult(
            allowed=True, action=BudgetAction.WARN, budget_name="none",
            remaining_usd=float("inf"), utilization_pct=0.0,
            message="未配置预算，放行",
        )

    estimated_usd = estimated_micro_usd / 1_000_000
    worst: BudgetCheckResult | None = None

    for row in rows:
        budget = Budget(
            name=row["id"],
            limit_usd=row["limit_micro_usd"] / 1_000_000,
            period=row["period"],
            scope_type="tenant",
            scope_value=tenant_id,
            action=BudgetAction(row["action"].lower()),
            warn_at_pct=row["warn_at_pct"],
            current_spend=_spend_usd(tenant_id, row["period"]),
        )

        projected = budget.current_spend + estimated_usd
        pct = budget.utilization_pct

        if projected > budget.limit_usd:
            if budget.action == BudgetAction.BLOCK:
                return BudgetCheckResult(
                    allowed=False, action=BudgetAction.BLOCK, budget_name=budget.name,
                    remaining_usd=budget.remaining, utilization_pct=pct,
                    message=f"已超出预算（{pct:.0f}%），本次请求被拒绝",
                )
            if budget.action == BudgetAction.DOWNGRADE:
                return BudgetCheckResult(
                    allowed=True, action=BudgetAction.DOWNGRADE, budget_name=budget.name,
                    remaining_usd=budget.remaining, utilization_pct=pct,
                    message=f"预算将超限（{pct:.0f}%），建议降级到小模型",
                    downgrade_model=DOWNGRADE_TARGET,
                )
            if budget.action == BudgetAction.THROTTLE:
                return BudgetCheckResult(
                    allowed=True, action=BudgetAction.THROTTLE, budget_name=budget.name,
                    remaining_usd=budget.remaining, utilization_pct=pct,
                    message=f"预算即将超限（{pct:.0f}%），建议限速",
                )

        candidate = BudgetCheckResult(
            allowed=True,
            action=BudgetAction.WARN if pct >= budget.warn_at_pct else BudgetAction.WARN,
            budget_name=budget.name,
            remaining_usd=budget.remaining,
            utilization_pct=pct,
            message=("已用 %.0f%% 预算" % pct) if pct >= budget.warn_at_pct else "预算充足",
        )
        if worst is None or candidate.utilization_pct > worst.utilization_pct:
            worst = candidate

    return worst or BudgetCheckResult(
        allowed=True, action=BudgetAction.WARN, budget_name="none",
        remaining_usd=float("inf"), utilization_pct=0.0, message="放行",
    )
