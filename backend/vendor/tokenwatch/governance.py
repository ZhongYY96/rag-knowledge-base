"""tokenwatch/governance.py — Budget enforcement and quota management."""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Callable
from tokenwatch.store import UsageStore


class BudgetAction(Enum):
    WARN = "warn"
    THROTTLE = "throttle"
    DOWNGRADE = "downgrade"
    BLOCK = "block"


@dataclass
class Budget:
    name: str
    limit_usd: float
    period: str
    scope_type: str
    scope_value: str
    action: BudgetAction = BudgetAction.WARN
    warn_at_pct: float = 80.0
    current_spend: float = 0.0

    @property
    def remaining(self) -> float:
        return max(0, self.limit_usd - self.current_spend)

    @property
    def utilization_pct(self) -> float:
        return (self.current_spend / self.limit_usd * 100) if self.limit_usd > 0 else 0

    @property
    def is_exceeded(self) -> bool:
        return self.current_spend >= self.limit_usd

    @property
    def is_warning(self) -> bool:
        return self.utilization_pct >= self.warn_at_pct and not self.is_exceeded


@dataclass
class BudgetCheckResult:
    allowed: bool
    action: BudgetAction
    budget_name: str
    remaining_usd: float
    utilization_pct: float
    message: str
    downgrade_model: str | None = None


class BudgetManager:
    def __init__(self, store: UsageStore, budgets: list[Budget] | None = None, downgrade_model: str = "claude-haiku-4-5-20250514"):
        self.store = store
        self.budgets = budgets or []
        self.downgrade_model = downgrade_model
        self._alert_callbacks: list[Callable] = []

    def add_budget(self, budget: Budget) -> None:
        self.budgets.append(budget)

    def on_alert(self, callback: Callable) -> None:
        self._alert_callbacks.append(callback)

    def check_budget(self, feature: str, team: str, estimated_cost: float) -> BudgetCheckResult:
        self._refresh_budgets()
        applicable = [b for b in self.budgets if b.scope_type == "global" or (b.scope_type == "feature" and b.scope_value == feature) or (b.scope_type == "team" and b.scope_value == team)]
        if not applicable:
            return BudgetCheckResult(True, BudgetAction.WARN, "none", float("inf"), 0, "No budgets")
        most_restrictive = None
        for b in applicable:
            if b.current_spend + estimated_cost > b.limit_usd:
                if b.action == BudgetAction.BLOCK:
                    return BudgetCheckResult(False, BudgetAction.BLOCK, b.name, b.remaining, b.utilization_pct, f"Blocked: {b.name}")
                elif b.action == BudgetAction.DOWNGRADE:
                    return BudgetCheckResult(True, BudgetAction.DOWNGRADE, b.name, b.remaining, b.utilization_pct, f"Downgraded: {b.name}", self.downgrade_model)
            if most_restrictive is None or b.utilization_pct > most_restrictive.utilization_pct:
                most_restrictive = BudgetCheckResult(True, BudgetAction.WARN, b.name, b.remaining, b.utilization_pct, "OK")
        return most_restrictive or BudgetCheckResult(True, BudgetAction.WARN, "none", float("inf"), 0, "OK")

    def _refresh_budgets(self) -> None:
        now = datetime.now(timezone.utc)
        for b in self.budgets:
            if b.period == "daily":
                since = now.replace(hour=0, minute=0, second=0, microsecond=0)
            elif b.period == "monthly":
                since = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            else:
                since = now.replace(minute=0, second=0, microsecond=0)
            kwargs = {"since": since.isoformat()}
            if b.scope_type == "feature":
                kwargs["feature"] = b.scope_value
            elif b.scope_type == "team":
                kwargs["team"] = b.scope_value
            records = self.store.query(**kwargs)
            b.current_spend = sum(r.cost_usd for r in records)
