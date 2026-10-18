"""tokenwatch/forecast.py — AI spend forecasting."""

from dataclasses import dataclass, field
from collections import defaultdict
import math
from tokenwatch.store import UsageStore


@dataclass
class ForecastResult:
    period_label: str
    base_forecast_usd: float
    optimistic_usd: float
    pessimistic_usd: float
    growth_rate_monthly_pct: float
    confidence_level: str
    assumptions: list[str] = field(default_factory=list)
    risk_factors: list[str] = field(default_factory=list)


class SpendForecaster:
    def __init__(self, store: UsageStore):
        self.store = store

    def forecast_monthly(self, months_ahead: int = 3, growth_assumption_pct: float | None = None, planned_features: list[dict] | None = None) -> list[ForecastResult]:
        monthly = self._get_monthly_costs()
        if len(monthly) < 2:
            return [ForecastResult("Insufficient data", 0, 0, 0, 0, "low", ["Need 2+ months data"])]
        costs = list(monthly.values())
        if growth_assumption_pct is not None:
            growth = growth_assumption_pct / 100
        else:
            rates = [(costs[i] - costs[i-1]) / costs[i-1] for i in range(1, len(costs)) if costs[i-1] > 0]
            growth = sum(rates) / len(rates) if rates else 0.0
        avg = sum(costs) / len(costs)
        std = math.sqrt(sum((c - avg) ** 2 for c in costs) / len(costs))
        cv = std / avg if avg > 0 else 0
        confidence = "high" if cv < 0.15 else ("medium" if cv < 0.30 else "low")
        band_mult = 0.15 if cv < 0.15 else (0.25 if cv < 0.30 else 0.40)
        last = costs[-1]
        results = []
        for m in range(1, months_ahead + 1):
            base = last * ((1 + growth) ** m)
            if planned_features:
                for f in planned_features:
                    if f.get("launch_month", 0) <= m:
                        base += f.get("estimated_monthly_cost", 0)
            band = base * band_mult * math.sqrt(m)
            results.append(ForecastResult(
                f"Month +{m}", base, base - band, base + band,
                growth * 100, confidence,
            ))
        return results

    def _get_monthly_costs(self) -> dict[str, float]:
        records = self.store.query()
        monthly: dict[str, float] = defaultdict(float)
        for r in records:
            monthly[r.timestamp[:7]] += r.cost_usd
        return dict(sorted(monthly.items()))
