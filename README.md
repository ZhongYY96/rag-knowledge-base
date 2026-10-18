# 企业级 RAG 知识库（本地模型 / 私有知识库 / 可评测）

一个可跑通的 RAG 闭环：**认证 → 私有知识库 → 文档入库 → 混合检索 → 流式问答（带引用）→ 评测 → 审计**。
全部模型可指向本地 OpenAI 兼容端点（默认 llama.cpp + bge-m3），不依赖任何云服务。

## 三步跑起来（傻瓜式）

```bash
npm ci          # 1. 装依赖（.npmrc 已放宽 peer 校验，无需额外参数）
npm run setup   # 2. 自检并自动拉起 Redis / Qdrant，生成 .env.local
npm run dev     # 3. 启动 → http://localhost:3000
```

`npm run setup` 会依次检查并给出**可执行的修法**：

| 检查 | 失败时怎么办 |
|---|---|
| Node ≥ 20 | 提示升级版本 |
| 依赖是否安装 | 提示 `npm ci` |
| Redis / Qdrant | 自动 `docker compose up -d`，60 秒内轮询端口；没有 Docker 则提示装或自建 |
| 对话 / 向量模型 | 只告警不阻断（可以稍后在 `/settings` 改地址） |

通过后输出：

```
✓ Node 24.21.0
✓ 依赖已安装
✓ Redis 可连接 127.0.0.1:6379
✓ Qdrant 可连接 127.0.0.1:6333
✓ 对话模型可访问 http://127.0.0.1:8000/v1
✓ 向量模型可访问 http://127.0.0.1:8001/v1
一切就绪。下一步：npm run dev
```

懒人版：`npm run up` = `setup` + `dev` 一条命令。
生产模式：`npm run serve`（= `next build && next start`），建议先用 `npm run setup` 自检。

首次使用：打开 `/register` 注册 → 建知识库 → 上传 md/txt/pdf → 进对话页提问。

> 模型服务需要自备（任何 OpenAI 兼容实现都可以）；也可以先启动，登录后在 `/settings` 里填远端地址。

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


## 备份与恢复

注册数据、知识库、对话记录**全部在 docker volume 里**，不在代码库：

| 操作 | 数据 |
|---|---|
| `npm ci` / `npm run dev` / 重装依赖 | ✅ 不受影响 |
| `docker compose down`（不带 -v） | ✅ volume 保留，数据还在 |
| `docker compose down -v` / `docker volume prune` | ❌ **全部丢失** |
| 换机器 / 重新 clone | ❌ 丢失（要手动迁移） |

### 备份

```bash
npm run backup        # → backups/<时间戳>/{redis-dump.rdb, qdrant-*.snapshot, uploads/}
```

三样都要备：Redis（用户/库/会话/审计）、Qdrant（向量）、`uploads/`（原始文件，重建索引要用）。

### 恢复

```bash
# 1. Redis：停服务 → 换 dump.rdb → 清掉 AOF（否则它会覆盖）→ 启动
docker compose stop redis
docker run --rm -v rag_redis_data:/data -v "$PWD/backups/<时间戳>":/backup alpine \
  sh -c "cp /backup/redis-dump.rdb /data/dump.rdb && rm -rf /data/appendonlydir"
docker compose start redis

# 2. Qdrant：上传快照
curl -X POST "http://localhost:6333/collections/kb_xxx/snapshots/upload?priority=snapshot" \
  -F "snapshot=@backups/<时间戳>/qdrant-kb_xxx.snapshot"

# 3. uploads：拷回项目根目录
cp -r backups/<时间戳>/uploads ./
```

> `backups/` 已加入 `.gitignore`——里面有用户数据，不要提交。

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
