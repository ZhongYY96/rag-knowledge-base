"""tokenwatch/store.py — Usage record storage."""

import json
from pathlib import Path
from typing import Iterator
from tokenwatch.meter import UsageRecord


class UsageStore:
    """Append-only store for usage records using JSON Lines format."""

    def __init__(self, path: str | Path = "tokenwatch_usage.jsonl"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, usage: UsageRecord) -> None:
        with open(self.path, "a") as f:
            f.write(json.dumps(usage.to_dict()) + "\n")

    def query(
        self, feature: str | None = None, model: str | None = None,
        user_id: str | None = None, team: str | None = None,
        since: str | None = None,
    ) -> list[UsageRecord]:
        if not self.path.exists():
            return []
        records = []
        for line in self._read_lines():
            data = json.loads(line)
            if feature and data.get("feature") != feature:
                continue
            if model and data.get("model") != model:
                continue
            if user_id and data.get("user_id") != user_id:
                continue
            if team and data.get("team") != team:
                continue
            if since and data.get("timestamp", "") < since:
                continue
            record = UsageRecord(**{
                k: v for k, v in data.items()
                if k in UsageRecord.__dataclass_fields__
            })
            records.append(record)
        return records

    def total_cost(self, **filters) -> float:
        return sum(r.cost_usd for r in self.query(**filters))

    def _read_lines(self) -> Iterator[str]:
        with open(self.path) as f:
            for line in f:
                line = line.strip()
                if line:
                    yield line

    def summary(self, **filters) -> dict:
        records = self.query(**filters)
        if not records:
            return {"total_records": 0, "total_cost_usd": 0.0}
        total_cost = sum(r.cost_usd for r in records)
        by_feature: dict[str, float] = {}
        by_model: dict[str, float] = {}
        for r in records:
            by_feature[r.feature] = by_feature.get(r.feature, 0) + r.cost_usd
            by_model[r.model] = by_model.get(r.model, 0) + r.cost_usd
        return {
            "total_records": len(records),
            "total_cost_usd": round(total_cost, 6),
            "total_input_tokens": sum(r.input_tokens for r in records),
            "total_output_tokens": sum(r.output_tokens for r in records),
            "total_cached_tokens": sum(r.cache_read_tokens for r in records),
            "avg_cost_per_request": round(total_cost / len(records), 6),
            "cache_hit_rate": sum(1 for r in records if r.is_cache_hit) / len(records),
            "cost_by_feature": by_feature,
            "cost_by_model": by_model,
        }
