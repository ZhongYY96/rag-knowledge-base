# 第三方代码说明

本目录下的 `vendor/tokenwatch/` **原样复制**自开源项目：

- 仓库：https://github.com/PacktPublishing/The-AI-Cost-Playbook
- 提交：`b384d15`
- 许可：MIT（见 `vendor/LICENSE`，版权归 Packt 所有）
- 来源：书中 `project/cap01` ~ `project/cap14` 各章的 `tokenwatch/` 目录合并而成（原仓库按章节增量提供，完整包需要合并）

## 我们复用了哪些模块

| 模块 | 用途 |
|---|---|
| `tokenwatch/config.py` + `pricing.yaml` | `TokenwatchConfig` / `ModelPricing`，计价核心 |
| `tokenwatch/meter.py` | `UsageRecord` 字段语义 |
| `tokenwatch/governance.py` | `Budget` / `BudgetAction` / `BudgetCheckResult`，预算领域模型 |

## 哪些没有用，为什么

| 模块 | 原因 |
|---|---|
| `store.py` | JSONL 追加 + 全量扫描，无法做按租户/模型聚合 → 换成 SQLite（`app/repo.py`） |
| `governance.BudgetManager` | `current_spend` 存内存，多进程各算各的 → 改成每次从库里现算（`app/policy.py`） |
| `tokens.py` / `cache.py` | 依赖 `anthropic` SDK，本项目只接 OpenAI 兼容协议 |
| `router.py` / `forecast.py` / `agents.py` / `selfhost.py` | 演示用不上（见 README「未实现」） |

## 我们改动了什么

复用的部分**未修改源码**；差异都在 `app/` 里：

1. 计价结果统一转成微美元整数（`app/calc.py`），避免浮点累加误差
2. 预算计数改成查询时计算（`app/policy.py`），为将来接 Redis 原子计数留好接口
3. 计量点固定在服务入口（`POST /v1/calls`），不依赖客户端 SDK
