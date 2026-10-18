"""tokenwatch/margins.py — Margin analysis for AI features."""

from dataclasses import dataclass


@dataclass
class MarginAnalysis:
    feature: str
    llm_cost_per_unit: float
    revenue_per_unit: float
    other_costs_per_unit: float
    gross_margin_pct: float
    contribution_margin_pct: float
    break_even_volume: int
    monthly_volume: int
    monthly_profit_usd: float
    is_profitable: bool


def analyze_margins(
    feature: str, llm_cost_per_unit: float, revenue_per_unit: float,
    other_costs_per_unit: float = 0.0, fixed_costs_monthly: float = 0.0,
    monthly_volume: int = 0,
) -> MarginAnalysis:
    total_variable = llm_cost_per_unit + other_costs_per_unit
    gross_margin = revenue_per_unit - llm_cost_per_unit
    contribution = revenue_per_unit - total_variable
    gm_pct = (gross_margin / revenue_per_unit * 100) if revenue_per_unit > 0 else -100
    cm_pct = (contribution / revenue_per_unit * 100) if revenue_per_unit > 0 else -100
    be = int(fixed_costs_monthly / contribution) if contribution > 0 else -1
    profit = (contribution * monthly_volume) - fixed_costs_monthly
    return MarginAnalysis(
        feature=feature, llm_cost_per_unit=llm_cost_per_unit,
        revenue_per_unit=revenue_per_unit, other_costs_per_unit=other_costs_per_unit,
        gross_margin_pct=gm_pct, contribution_margin_pct=cm_pct,
        break_even_volume=be, monthly_volume=monthly_volume,
        monthly_profit_usd=profit, is_profitable=profit > 0,
    )
