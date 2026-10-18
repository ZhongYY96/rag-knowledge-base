# 个人 RAG 知识库

> 本地模型 · 私有知识库 · **引用可溯源** · 可评测

从登录、建库、上传文档，到提问、看引用、跑评测、查审计，一条链路都能走通。
模型可以全本地跑（llama.cpp + bge-m3），也能接任意 OpenAI 兼容接口。

![知识库问答：引用角标与来源卡片](docs/images/06-chat.png)

## 亮点

**答案带出处，点开就能核对**

- 每句结论后面有个小角标，点一下就是这个说法在原文里的那一段：哪个文件、第几块、相似度多少
- 想看完整上下文点「查看原文」，直接跳到文档对应位置
- 模型要是编了个不存在的编号，角标会变红划掉，一眼能看出它在乱标
- 用混合检索时，还会显示这条结果排第几、两路分数各是多少

**边生成边显示，切页面也不会断**

- 回答是一个字一个字出来的，不用等整段写完
- 生成跑在后台，切到别的页面、刷新、关掉标签页，都不影响它跑完，结果会存下来
- 回来时前面已经生成的内容会补上，不用重来；等太久可以点取消

**检索方式可以调，默认选了更稳的那种**

- 可以只用向量，也可以向量加关键词一起用；合并方式、权重、候选数量都能在设置里改
- 默认用哪种，是拿测试集跑过之后定的，不是凭感觉

**效果好坏自己测，不靠感觉**

- 自带一套测试题，分简单、困难、本该拒答三类，看命中率、召回率、引用对不对、该拒答的有没有拒
- 页面上点一下就出结果，命令行也能跑，两边用同一套判分规则，数字不会对不上

**登录、审计、部署这些都有**

- 登录用 JWT，密码加盐存储；别人的知识库你打开就是 404，不告诉你在不在
- 谁登录了、谁建了库、谁删了文档、谁改了配置、谁试图越权，都有记录，密码这类信息不会写进去
- 一条命令检查环境和依赖，缺什么直接告诉你；数据能一键备份

## 界面

**对话页 —— 引用角标可点击，来源可展开、可定位原文**

| 回答里的引用角标 | 展开查看被引用的原文 |
|---|---|
| ![对话页](docs/images/06-chat.png) | ![展开引用](docs/images/07-citation-expanded.png) |

| 定位到原文并高亮 | 质量报告与评测 |
|---|---|
| ![原文定位](docs/images/08-source-preview.png) | ![质量报告](docs/images/05-eval-progress.png) |

| 工作台 | 知识库列表 |
|---|---|
| ![工作台](docs/images/01-dashboard.png) | ![知识库](docs/images/02-knowledge-bases.png) |

| 知识库详情：文档与评测入口 |
|---|
| ![知识库详情](docs/images/03-kb-detail.png) |

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

## 评测结果

当前语料（2 篇文档）、12 道题，默认配置下：

| 档位 | 样本 | 命中@K | Recall | 引用正确 | 拒答率 |
|---|---|---|---|---|---|
| easy | 6 | 100% | 100% | 80% | — |
| hard | 4 | 100% | 100% | 100% | — |
| unanswerable | 2 | — | — | — | 100% |

判分规则写在 `docs/eval-spec.md`，可以自己按规则复核。

![评测进行中](docs/images/04-eval-start.png)

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

## 常见问题

**页面没有样式 / 接口 500 / 报 `MODULE_NOT_FOUND .next/...manifest.json`**

`next build` 与 `next dev` 不能同时跑（build 会覆盖 dev 的 `.next`）：

```bash
pkill -f "next dev"; pkill -f "next-server"
rm -rf .next
npm run dev
```

自查：`curl -s localhost:3000/login | grep -o '/_next/static/css/[^"]*'`，无输出即样式未加载。
