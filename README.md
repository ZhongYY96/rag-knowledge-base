# 企业级 RAG 知识库

> 本地模型 · 私有知识库 · **引用可溯源** · 可评测

一条可跑通的完整链路：**认证 → 私有知识库 → 文档入库 → 混合检索 → 流式问答（带引用）→ 评测 → 审计**。
模型可完全本地化（llama.cpp + bge-m3），也可指向任意 OpenAI 兼容端点。

## 亮点

**① 引用可溯源，不只是"贴个来源"**

- 答案里每个论断带 `[citation:N]` 角标，**点击展开对应原文片段**：文件名、页码/块号、相似度分数
- 「查看原文」可定位到文档里的具体位置，核对成本从"翻全文"降到"看一眼"
- 模型编造出不存在的编号时**标红删除线**——引用是否可信，一眼可见
- 混合检索下额外展示融合排名与两路分数，排序依据可解释

**② 流式输出，且切换页面不中断**

- SSE 逐字输出，首字延迟 1~2 秒（关闭推理链后）
- 生成任务托管在后台（`after()` + 心跳检测），**切页面、刷新、关标签都不影响任务跑完**
- 回来时从 Redis 回放已生成内容，不丢进度；异常任务自动失效，可手动取消

**③ 检索策略可配，默认值由评测决定**

- 支持纯向量 / 向量+关键词双路，RRF 融合的 k、两路权重、候选倍数全部可调
- 默认关闭混合检索不是拍脑袋：实测在当前语料下它会让 hard 档召回从 100% 掉到 87.5%，所以只保留开关（见 `docs/retrieval-strategy.md`）

**④ 评测闭环，指标可复核**

- 三层用例（easy / hard / unanswerable）× 四项指标（命中@K、Recall、引用正确率、拒答率）+ P0 硬错误
- 页面可跑（异步 + 进度条），CLI 可跑（`npm run eval`），**同一份判定内核**，数字不会两套

**⑤ 企业级基础件**

- JWT + httpOnly Cookie，密码 scrypt；越权访问统一返回 **404**（防 ID 枚举）
- 审计日志：统一入口埋点（含越权探测），敏感字段写入即脱敏，可按操作/知识库过滤
- 一键部署自检、备份脚本、配置集中校验（生产缺变量直接启动失败）

## 三步跑起来

```bash
npm ci          # 1. 装依赖（.npmrc 已放宽 peer 校验）
npm run setup   # 2. 自检并自动拉起 Redis / Qdrant，生成 .env.local
npm run dev     # 3. 启动 → http://localhost:3000
```

懒人版：`npm run up`（= setup + dev）。生产：`npm run serve`（build + start）。

`npm run setup` 会检查 Node 版本、依赖、Redis/Qdrant、模型可达性、端口占用，**每项失败都给可执行的修法**。模型服务需自备（任何 OpenAI 兼容实现均可），也可先启动后在 `/settings` 填远端地址。

首次使用：`/register` 注册 → 建知识库 → 上传 PDF/TXT/MD → 进对话页提问。

## 功能

| 模块 | 说明 |
|---|---|
| 认证 | JWT(HS256) + httpOnly Cookie、scrypt 密码、会话版本号可强制下线 |
| 多租户 | 知识库按 owner 隔离，越权返回 404 |
| 入库 | PDF/TXT/Markdown 解析 → 切分 → dense + sparse 双向量写入；单文件 10MB 限制 |
| 检索 | dense / hybrid（RRF，k 与两路权重可配）；旧索引自动降级为纯向量 |
| 问答 | SSE 流式、引用角标可点击、Markdown 渲染、多轮追问改写 |
| 任务 | 后台生成 + 心跳 + 孤儿任务清理 + 手动取消 |
| 评测 | 三层用例、四项指标、页面 + CLI 双入口、报告落盘 |
| 审计 | 注册/登录/建库/上传/删库/改配置/评测/越权，全量记录 + 脱敏 |

## 评测结论

2 篇文档 / 12 条用例，`topK=3`：

| 配置 | 命中@K | Recall | 引用正确 | 拒答率 |
|---|---|---|---|---|
| dense（默认） | 100% | 100% | 80%~100% | 100% |
| hybrid 0.7:0.3 | 100% | 87.5% | — | — |

混合检索在本语料下掉召回，因此**默认关闭、保留开关**。判定口径见 `docs/eval-spec.md`。

## 目录

```
src/app/            页面 + API 路由
src/lib/auth/       认证、会话、权限
src/lib/rag/        检索 / 生成 / 评测 / 任务
src/lib/            Redis、Qdrant 适配、设置、审计、配置
scripts/            CLI：评测、重建索引、部署自检、备份、迁移
docs/               评测口径、检索策略
```

## 配置与环境变量

连接信息只从环境变量来，仓库里只有 `.env.example`：

```bash
cp .env.example .env.local     # 本地（已被 .gitignore 忽略）
```

| 变量 | 用途 |
|---|---|
| `REDIS_URL` / `QDRANT_URL` | 元数据 + 向量库 |
| `AUTH_SECRET` | JWT 签名密钥（生产必须换） |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` | 对话模型 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` | 向量模型 |

生产缺关键变量会**启动失败**而不是静默回退；启动日志打印脱敏后的依赖地址，便于排查连错库。

## 备份

```bash
npm run backup    # → backups/<时间戳>/{redis-dump.rdb, qdrant-*.snapshot, uploads/}
```

数据在 docker volume 里：`docker compose down` 不影响，`down -v` 会清空。恢复步骤见脚本输出与 `docs/`。

## 规划中

- Rerank 精排（语料上量后引入，评测口径已就绪）
- 任务队列化（替换 `after()`，支持跨进程重启续跑）
- 更多格式：DOCX、扫描件 OCR

## 已知边界

- 模型能力取决于所部署的模型；默认 MiniCPM5-2B 在复杂推理上有限
- 单机部署，未做多副本压测；Redis/Qdrant 需自行备份
- 无内置限流（登录/注册除外）

## 常见问题

**页面没有样式 / 接口 500 / 报 `MODULE_NOT_FOUND .next/...manifest.json`**

`next build` 与 `next dev` 不能同时跑（build 会覆盖 dev 的 `.next`）：

```bash
pkill -f "next dev"; pkill -f "next-server"
rm -rf .next
npm run dev
```

自查：`curl -s localhost:3000/login | grep -o '/_next/static/css/[^"]*'`，无输出即样式未加载。
