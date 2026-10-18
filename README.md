# 企业级 RAG 知识库（本地模型 / 私有知识库 / 可评测）

一个可跑通的 RAG 闭环：**认证 → 私有知识库 → 文档入库 → 混合检索 → 流式问答（带引用）→ 评测 → 审计**。
全部模型可指向本地 OpenAI 兼容端点（默认 llama.cpp + bge-m3），不依赖任何云服务。

## 快速开始

```bash
# 1. 基础设施
docker compose up -d redis qdrant

# 2. 依赖与环境
npm ci                      # 若 peer 冲突：npm ci --legacy-peer-deps
cp .env.example .env.local  # 按需修改 Redis/Qdrant/模型地址

# 3. 本地模型（可选，任选 OpenAI 兼容实现）
#   chat:       http://127.0.0.1:8000/v1   MiniCPM5-2B
#   embedding:  http://127.0.0.1:8001/v1   bge-m3 (1024 维)

# 4. 启动
npm run dev     # http://localhost:3000
```

首次访问 `/register` 注册，登录后建知识库、上传 md/txt/pdf，即可在 `/chat/<kbId>` 提问。

## 功能

| 模块 | 说明 |
|---|---|
| 认证 | JWT(HS256) + httpOnly Cookie、scrypt 密码、会话版本号可强制下线 |
| 多租户 | 知识库按 owner 隔离；越权统一返回 **404**（防 ID 枚举） |
| 入库 | md/txt/pdf 解析 → 切分 → 双向量写入（dense + sparse） |
| 检索 | dense / hybrid（RRF，k 与两路权重可配）；旧索引自动降级 |
| 问答 | 流式输出（SSE）、引用角标可点击、Markdown 渲染、追问改写 |
| 任务 | `after()` 后台生成 + 心跳检测 + 孤儿任务清理 + 手动取消 |
| 评测 | 三层用例（easy/hard/unanswerable）、4 项指标、页面 + CLI 双入口 |
| 审计 | 统一入口埋点、敏感字段脱敏、按操作/知识库过滤 |

## 脚本

```bash
npm run eval         # 评测 CLI（支持 --mode dense|hybrid --weights --topk）
npm run reindex      # 旧索引 → 混合索引重建（--dry-run 先看）
npm run test:auth    # 认证/越权冒烟测试
npm run migrate:kb   # 旧数据补 ownerId
```

## 评测结论（真实数据，2 篇文档 / 12 条用例）

| 配置 | 命中@K | Recall | 引用正确 | 幻觉 H1 |
|---|---|---|---|---|
| dense | 100% | 100% | 80%~100% | 20%~50% |
| hybrid 0.7:0.3 | 100% | **87.5%** | — | — |

**混合检索在当前语料下掉召回**，所以默认关闭、只保留开关。详见 `docs/retrieval-strategy.md`。

## 已知限制

- 上传无大小/类型校验；API Key 明文存 Redis（生产应加密）
- DOCX 不支持；扫描版 PDF 无文字层
- 无 rerank、无限流（登录/注册除外）
- 详见 `docs/` 与 `README-migration.md`

## 目录

```
src/app/            页面 + API 路由
src/lib/auth/       认证、会话、权限
src/lib/rag/        检索/生成/评测/任务
src/lib/            Redis、Qdrant 适配、设置、审计
scripts/            CLI：评测、重建索引、迁移
docs/               评测口径、检索策略
```
