"""存储层：SQLite（明细 + 预算）。

为什么不用 JSONL 追加存储：
按租户/模型做聚合时需要全文件扫描，数据一多就不可用。
这里用带索引的表，字段与上报契约一一对应。
"""
import json
import sqlite3
from contextlib import contextmanager

from .settings import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  feature           TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd    INTEGER NOT NULL DEFAULT 0,
  retrieval_ms      INTEGER,
  ttft_ms           INTEGER,
  latency_ms        INTEGER,
  status            TEXT,
  meta              TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_tenant_ts ON calls(tenant_id, ts);

CREATE TABLE IF NOT EXISTS budgets (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  period           TEXT NOT NULL,          -- daily / monthly
  limit_micro_usd  INTEGER NOT NULL,
  action           TEXT NOT NULL DEFAULT 'WARN',
  warn_at_pct      REAL NOT NULL DEFAULT 80,
  enabled          INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_scope ON budgets(tenant_id, period);
"""


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH, timeout=5)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db() -> None:
    with conn() as c:
        c.executescript(SCHEMA)


def insert_call(rec: dict) -> bool:
    """写入一条调用记录。返回 False 表示 request_id 重复（幂等）。"""
    with conn() as c:
        cur = c.execute(
            """INSERT OR IGNORE INTO calls
               (id, ts, tenant_id, feature, model, prompt_tokens, completion_tokens,
                cached_tokens, cost_micro_usd, retrieval_ms, ttft_ms, latency_ms, status, meta)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                rec["id"], rec["ts"], rec["tenant_id"], rec["feature"], rec["model"],
                rec["prompt_tokens"], rec["completion_tokens"], rec["cached_tokens"],
                rec["cost_micro_usd"], rec.get("retrieval_ms"), rec.get("ttft_ms"),
                rec.get("latency_ms"), rec.get("status", "ok"),
                json.dumps(rec.get("meta") or {}, ensure_ascii=False),
            ),
        )
        return cur.rowcount > 0


def spend_micro(tenant_id: str, since_iso: str) -> int:
    with conn() as c:
        row = c.execute(
            "SELECT COALESCE(SUM(cost_micro_usd), 0) AS s FROM calls WHERE tenant_id=? AND ts>=?",
            (tenant_id, since_iso),
        ).fetchone()
        return int(row["s"])


def summary(tenant_id: str, since_iso: str) -> dict:
    with conn() as c:
        total = c.execute(
            """SELECT COUNT(*) AS calls, COALESCE(SUM(cost_micro_usd),0) AS cost,
                      COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct
               FROM calls WHERE tenant_id=? AND ts>=?""",
            (tenant_id, since_iso),
        ).fetchone()

        by_model = [
            dict(r) for r in c.execute(
                """SELECT model, COUNT(*) AS calls, COALESCE(SUM(cost_micro_usd),0) AS cost_micro_usd
                   FROM calls WHERE tenant_id=? AND ts>=? GROUP BY model ORDER BY cost_micro_usd DESC""",
                (tenant_id, since_iso),
            )
        ]

        by_day = [
            dict(r) for r in c.execute(
                """SELECT substr(ts,1,10) AS day, COUNT(*) AS calls,
                          COALESCE(SUM(cost_micro_usd),0) AS cost_micro_usd
                   FROM calls WHERE tenant_id=? AND ts>=? GROUP BY day ORDER BY day""",
                (tenant_id, since_iso),
            )
        ]

        lat_rows = c.execute(
            "SELECT latency_ms FROM calls WHERE tenant_id=? AND ts>=? AND latency_ms IS NOT NULL",
            (tenant_id, since_iso),
        ).fetchall()

    lat = sorted(r["latency_ms"] for r in lat_rows)

    def pct(p):
        if not lat:
            return None
        idx = min(len(lat) - 1, int(round((p / 100) * (len(lat) - 1))))
        return lat[idx]

    return {
        "calls": total["calls"],
        "cost_micro_usd": int(total["cost"]),
        "prompt_tokens": int(total["pt"]),
        "completion_tokens": int(total["ct"]),
        "p50_latency_ms": pct(50),
        "p95_latency_ms": pct(95),
        "by_model": by_model,
        "by_day": by_day,
    }


def list_calls(tenant_id: str, since_iso: str, limit: int = 50) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            """SELECT * FROM calls WHERE tenant_id=? AND ts>=?
               ORDER BY ts DESC LIMIT ?""",
            (tenant_id, since_iso, limit),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["meta"] = json.loads(d["meta"]) if d["meta"] else {}
        except Exception:
            d["meta"] = {}
        out.append(d)
    return out


# ── 预算 ──

def get_budgets(tenant_id: str) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM budgets WHERE tenant_id=? AND enabled=1", (tenant_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_budget(tenant_id: str, period: str, limit_micro_usd: int,
                  action: str = "WARN", warn_at_pct: float = 80.0) -> dict:
    bid = f"{tenant_id}:{period}"
    with conn() as c:
        c.execute(
            """INSERT INTO budgets (id, tenant_id, period, limit_micro_usd, action, warn_at_pct, enabled)
               VALUES (?,?,?,?,?,?,1)
               ON CONFLICT(id) DO UPDATE SET
                 limit_micro_usd=excluded.limit_micro_usd,
                 action=excluded.action,
                 warn_at_pct=excluded.warn_at_pct,
                 enabled=1""",
            (bid, tenant_id, period, limit_micro_usd, action.upper(), warn_at_pct),
        )
    return {"id": bid, "tenant_id": tenant_id, "period": period,
            "limit_micro_usd": limit_micro_usd, "action": action.upper(),
            "warn_at_pct": warn_at_pct}
