# 成本评估与治理服务（backend/）

FastAPI 实现，为 RAG 主应用提供**用量记录、成本归因、预算裁决**。

> 它是 RAG 项目的平台层：主应用只负责问答，回答"花了多少钱、慢在哪一环、超预算怎么办"由本服务提供。

## 与 Packt 仓库的关系

代码基础是 [The-AI-Cost-Playbook](https://github.com/PacktPublishing/The-AI-Cost-Playbook)（MIT）：

- `vendor/tokenwatch/`：**原样复用**其计价与预算领域模型
- `app/`：重写存储、裁决与接口

复用了什么、为什么改，见 [NOTICE.md](NOTICE.md)。

## 目录

```
backend/
├── app/
│   ├── main.py       FastAPI 路由
│   ├── calc.py       计费（复用 tokenwatch.config.ModelPricing）
│   ├── policy.py     预算裁决（复用 tokenwatch.governance）
│   ├── repo.py       SQLite 存储（替换原 JSONL）
│   ├── schemas.py    请求模型
│   └── settings.py   环境变量
├── vendor/tokenwatch/   复用的第三方代码 + LICENSE
├── pricing.yaml         计价表（含本地模型等效单价）
└── data/cost.db         SQLite（gitignore）
```

## 运行

```bash
cd backend
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --port 8100
# 文档：http://127.0.0.1:8100/docs
```

Docker：

```bash
docker build -t rag-cost-api .
docker run -p 8100:8100 -e COST_INTERNAL_TOKEN=dev-internal-token rag-cost-api
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `COST_INTERNAL_TOKEN` | `dev-internal-token` | 服务间鉴权，浏览器永远不接触 |
| `COST_DB` | `backend/data/cost.db` | SQLite 路径 |
| `COST_PRICING` | `backend/pricing.yaml` | 计价表 |
| `COST_DOWNGRADE_TARGET` | `MiniCPM5-2B` | 超预算时的降级目标 |

## 接口

所有接口要求请求头 `X-Internal-Token`。

```bash
T='X-Internal-Token: dev-internal-token'

# 1. 调用前预检（预算裁决）
curl -s -X POST localhost:8100/v1/preflight -H "$T" -H 'Content-Type: application/json' -d '{
  "tenant_id":"kb_xxx","model":"MiniCPM5-2B","prompt_text":"...","max_tokens":512 }'
# → {"action":"WARN","allowed":true,"remaining_micro_usd":1000000,
#    "estimated_micro_usd":{"min":45,"max":414},"suggested_model":null}

# 2. 调用后上报（幂等）
curl -s -X POST localhost:8100/v1/calls -H "$T" -H 'Content-Type: application/json' -d '{
  "request_id":"uuid","tenant_id":"kb_xxx","model":"MiniCPM5-2B",
  "usage":{"prompt_tokens":1200,"completion_tokens":180},
  "timings":{"retrieval_ms":310,"ttft_ms":1500,"latency_ms":11800} }'

# 3. 汇总 / 明细 / 预算
curl -s "localhost:8100/v1/summary?tenant_id=kb_xxx&days=7" -H "$T"
curl -s "localhost:8100/v1/calls?tenant_id=kb_xxx&limit=20" -H "$T"
curl -s -X PUT localhost:8100/v1/budgets -H "$T" -H 'Content-Type: application/json' -d '{
  "tenant_id":"kb_xxx","period":"daily","limit_micro_usd":1000000,"action":"DOWNGRADE" }'
```

四级动作：`WARN` → `THROTTLE` → `DOWNGRADE` → `BLOCK`。**服务端只裁决，执行在客户端**（只有客户端知道怎么换模型）。

## 主应用如何接

```js
// 发消息前
const verdict = await fetch(`${COST_API}/v1/preflight`, { ... })
                        .then(r => r.json())
                        .catch(() => ({ action: 'ALLOW' }));   // fail-open
if (verdict.action === 'BLOCK') return friendlyError(verdict.reason);
if (verdict.action === 'DOWNGRADE') model = verdict.suggested_model;

// 生成结束后（不 await）
fetch(`${COST_API}/v1/calls`, { method: 'POST', body: JSON.stringify({
  request_id: requestId, tenant_id: kbId, model,
  usage: { prompt_tokens, completion_tokens },
  timings: { retrieval_ms, ttft_ms, latency_ms },
}) }).catch(() => {});
```

## 设计取舍

| 决策 | 原因 |
|---|---|
| 服务端裁决、客户端执行 | 服务端不知道业务侧模型清单与降级关系，也不该知道 |
| 明细存 SQLite | 需要按租户/模型/天聚合；JSONL 全扫撑不住 |
| 成本用微美元整数 | 浮点累加会让"已花 0.99"变成 1.0000001，误触发 BLOCK |
| `request_id` 主键去重 | 重试不重复计费 |
| 预检 fail-open | 观测不能成为可用性瓶颈 |

## 未实现（有意）

- Redis 原子计数（当前直接查 SQLite，量小够用；接入后用于高并发预检）
- 日聚合表 `rollups_daily`（数据量大后再加）
- 语义缓存、模型路由（属于业务层，放 RAG 主应用更合适）
- 多币种、发票、财务对账
