"""tokenwatch/economics.py — Unit economics calculations."""

from dataclasses import dataclass
from collections import defaultdict
from tokenwatch.store import UsageStore
from tokenwatch.meter import UsageRecord


@dataclass
class FeatureEconomics:
    feature: str
    total_cost_usd: float
    request_count: int
    unique_users: int
    cost_per_request: float
    cost_per_user: float
    avg_input_tokens: float
    avg_output_tokens: float
    avg_latency_ms: float
    cache_hit_rate: float
    p95_cost_per_request: float
    cost_trend_pct: float


class EconomicsEngine:
    def __init__(self, store: UsageStore):
        self.store = store

    def feature_economics(self, since: str | None = None, compare_period: bool = True) -> list[FeatureEconomics]:
        records = self.store.query(since=since)
        if not records:
            return []
        by_feature: dict[str, list[UsageRecord]] = defaultdict(list)
        for r in records:
            by_feature[r.feature].append(r)
        results = []
        for feature, recs in by_feature.items():
            costs = sorted([r.cost_usd for r in recs])
            total = sum(costs)
            count = len(recs)
            users = set(r.user_id for r in recs if r.user_id)
            p95_idx = int(count * 0.95)
            p95 = costs[min(p95_idx, count - 1)]
            cache_hits = sum(1 for r in recs if r.is_cache_hit)
            results.append(FeatureEconomics(
                feature=feature, total_cost_usd=total,
                request_count=count, unique_users=len(users),
                cost_per_request=total / count,
                cost_per_user=total / len(users) if users else total,
                avg_input_tokens=sum(r.input_tokens for r in recs) / count,
                avg_output_tokens=sum(r.output_tokens for r in recs) / count,
                avg_latency_ms=sum(r.latency_ms for r in recs) / count,
                cache_hit_rate=cache_hits / count if count > 0 else 0.0,
                p95_cost_per_request=p95, cost_trend_pct=0.0,
            ))
        return sorted(results, key=lambda x: x.total_cost_usd, reverse=True)
