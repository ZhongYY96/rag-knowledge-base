# 迁移说明：Upstash → 自建 Redis + Qdrant（方案 B）

## 改了什么

| 原来 | 现在 | 涉及文件 |
|---|---|---|
| `@upstash/redis`（元数据） | `ioredis` → Docker Redis | `src/lib/redis.js`（新增）、`src/lib/database.js` |
| `@upstash/ratelimit`（middleware 限流） | 自己写的 ZSET 滑动窗口，挪进 Route Handler | `src/middleware.js`、`src/app/api/route.js` |
| `@upstash/vector`（向量库） | `@qdrant/js-client-rest` + `@langchain/community/vectorstores/qdrant` | `src/lib/vectorStore.js`（新增）、3 个调用点 |

**只新增两个 npm 包**：`ioredis`、`@qdrant/js-client-rest`。
向量库适配层直接用已有的 `@langchain/community@0.3.53` 里自带的那个 —— **不要装 `@langchain/qdrant`**，原因见下面「坑 ④」。

**保留不变**：Redis 的数据结构设计（Hash / Set / List 的那套 key 命名）、`namespace = knowledgeBaseId` 的隔离语义、RAG 链路本身。

> ⚠️ **唯一的语义变化**：向量 ID。原来靠 `${docId}-chunk-${i}` 这种前缀规则做删除，
> 现在删除走 `metadata.documentId` 过滤，不再依赖 ID 命名（community 版的
> `QdrantVectorStore` 内部固定用 uuid，不支持自定义 ID）。语义更准，且不会误伤。

---

## 这个仓库是 npm workspaces monorepo

`/Users/zhongyaoyi/Downloads/Code-main/package.json` 里声明了
`"workspaces": ["ch02/*", ..., "ch11/*"]`，依赖被提升到**仓库根**的 `node_modules`。

所以**不要在 `ch11/rag` 里直接 `npm install`**，要么回根目录用 `-w`，要么在根目录整体装：

```bash
cd /Users/zhongyaoyi/Downloads/Code-main    # ← 注意是仓库根
npm install ioredis @qdrant/js-client-rest -w chat-rag
npm uninstall @upstash/redis @upstash/ratelimit @upstash/vector -w chat-rag
```

（`chat-rag` 是 `ch11/rag/package.json` 里的 name。另外根目录 `.nvmrc` 写的是 v20.11.1，
而 `sharp` / `pdf-parse` 有原生模块，node 版本差太多可能出现 ABI 不匹配 —— 建议 `nvm use`。）

---

## 启动步骤

### 1. 起数据库

```bash
docker compose up -d
docker compose ps          # 两个都应该是 running
```

验证：

```bash
redis-cli ping                              # → PONG
curl -s http://127.0.0.1:6333/collections   # → {"result":{"collections":[]},"status":"ok"}
```

### 2. 依赖（已完成，但你需要知道为什么没走 npm）

**⚠️ 这个仓库根目录的 `npm install` 是坏的**，跟本次迁移无关：

```
根 package.json 同时声明：
  "@langchain/core": "^1.2.17"          ← 1.x
  "@langchain/google-genai": "^0.2.18"  ← 它要求 @langchain/core >=0.3.58 <0.4.0
```

两者互斥，任何 `npm install` 都会 ERESOLVE。lockfile 是完整的（每个 chapter 各有
自己的 `@langchain/core@0.3.80`），所以 `npm ci` 还能用，但 `npm install` 不行。

**本次采用的绕行方式**：不动 lockfile，直接把包装进 `ch11/rag/node_modules/`：

```
已放入 ch11/rag/node_modules/：
  ioredis@6.0.0                          + @ioredis/commands, cluster-key-slot,
                                            denque, redis-errors, standard-as-callback
  @qdrant/js-client-rest@1.18.0          + @qdrant/openapi-typescript-fetch
  undici@6.29.0                          （1.18.0 要求 ^6.24.0，根里是 7.x）
共同从根 node_modules 复用：debug@4.4.3

package.json 已同步声明（ioredis + @qdrant/js-client-rest ~1.18.0，三个 @upstash/* 已移除）
```

好处是**完全不影响其他 chapter**。代价是 `npm ci` 会把这份手工放置冲掉 ——
真要重装依赖，得先修上面的根冲突（要么把 google-genai 升到 1.x，
要么给根加 `--legacy-peer-deps`）。


### 3. 填 `.env.local`

至少这四个：

```bash
REDIS_URL=redis://127.0.0.1:6379
QDRANT_URL=http://127.0.0.1:6333
GEMINI_API_KEY=...          # embedding 和问答都用它
CLERK_SECRET_KEY=...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
```

> `.env.example` 里原来**漏了** `UPSTASH_VECTOR_REST_URL/TOKEN` 两项 —— 就算填了
> Redis 那两项，RAG 一调用照样炸。新版已补齐。

### 4. 跑起来

```bash
npm run dev
open http://localhost:3000/dashboard
```

---

## 验证清单

**已完成（本次已实测通过）**

- [x] Redis 连通：`hgetall` 缺失 key 返回 `{}`，`isMissingHash` 正确判为缺失
- [x] `getKnowledgeBase(不存在的 id)` 返回 `null`（迁移前会返回空对象，是个隐性 bug）
- [x] 建库 / 查库 / 加文档 / 删文档 / 删库 全链路往返
- [x] Qdrant 建 collection + payload 索引
- [x] chunk 写入（3 条）+ `similaritySearch` + `asRetriever({k})`（**这里抓到 `search` 被移除的坑**）
- [x] 按 `metadata.documentId` 过滤删除（3 → 1 条）
- [x] 删知识库时 drop 整个 collection
- [x] **`GET /dashboard` → 200（原来的 500 已消失）**
- [x] **`GET /api/knowledgebase` → 200，`POST` 建库后能查到，Redis 里 key 正确**

**还需你自己跑（依赖你的 API Key）**

- [ ] 上传文档 → `GEMINI_API_KEY` 生成 embedding → Qdrant 出现 `kb_<id>` collection
      `curl -s http://127.0.0.1:6333/collections | python3 -m json.tool`
- [ ] 提问 → 能召回并带引用来源（需要 `GEMINI_API_KEY`）
- [ ] 连打 6 次 `/api` → 第 6 次返回 429（需要 Clerk 登录态）


---

## 四个必须知道的坑

### ① `hgetall` 的空值语义变了

```
key 不存在时：@upstash/redis → null      ioredis → {}
```

原代码到处是 `if (!kb) return null`，而 `{}` 是 truthy，这些判断会**静默失效**
（页面会显示一条空白记录，而不是查不到）。

已统一替换为 `isMissingHash()` 守卫，见 `src/lib/redis.js`。

**以后自己写新查询时，记住这个差异。**

### ② 限流不能留在 middleware 里

Next.js 的 middleware 默认跑在 **Edge Runtime**，没有 TCP socket，
`ioredis` / `node-redis` 这类长连接客户端在里面**根本连不上**。

这正是原代码只能用 HTTP 协议版 Upstash 的原因。换成自建 Redis 后，
限流必须放进 Node.js runtime（Route Handler）。

如果一定要在 middleware 里限流，Next.js 15.2+ 支持 `runtime: 'nodejs'` 的
middleware（15.5 转正），但会让每个请求（含静态资源）都多一次 Redis 往返，
不推荐。

### ③ 一个知识库一个 Qdrant collection

这是对 `namespace: knowledgeBaseId` 的 1:1 映射 —— 检索天然隔离，
不需要 filter，也不可能跨库串数据。

代价是知识库多了 collection 会变多。Qdrant 的 collection 很轻，
这个量级无所谓；真到了几千个再改成单 collection + payload filter。

### ④ 不要装 `@langchain/qdrant`

搜"LangChain JS Qdrant"第一个跳出来的多半是 `@langchain/qdrant`，但**装不了**：

```
@langchain/qdrant@1.0.3  →  peerDependencies: { "@langchain/core": "^1.1.47" }
本项目实际版本            →  @langchain/core@0.3.80              ← 大版本冲突
```

npm 会报 `ERESOLVE`，用 `--legacy-peer-deps` 硬装则会在运行时炸。

**正确做法**：用 `@langchain/community@0.3.53` 里自带的那个：

```js
import { QdrantVectorStore } from '@langchain/community/vectorstores/qdrant';
```

它虽然标了 `@deprecated Install and import from @langchain/qdrant instead.`，
但**两者的 API 完全一致**（`QdrantLibArgs`、`fromExistingCollection`、`ensureCollection`
逐个比对过），只是搬家了而已。等整个项目升到 LangChain 1.x，把 import 路径一换就行。

两个次要差异，写代码时注意：

| | community 0.3.53 | @langchain/qdrant 1.x |
|---|---|---|
| `addDocuments` 的 `ids` 选项 | ❌ 不支持（内部固定 `uuid()`） | ✅ 支持 |
| 删除方式 | 按 `metadata.*` 过滤 | 可按 ID 或过滤 |

### ⑤ `@qdrant/js-client-rest` 必须钉在 `~1.18.0`，不能用最新的

**这是端到端测试才抓出来的坑，静态看代码完全看不出来。**

```
@qdrant/js-client-rest@1.19.0  →  只有 query / queryBatch / queryGroups，search 被删了
@langchain/community@0.3.53    →  内部调 this.client.search(...)   ← 运行时炸
```

报错长这样，而且只在**检索**时才炸（写入正常）：

```
TypeError: this.client.search is not a function
    at QdrantVectorStore.similaritySearchVectorWithScore (qdrant.js:135)
```

11.19.0 移除了 `search`（Qdrant 用统一的 `query` API 取代了它），而
community 的适配层还停在老 API。它的 peerDependency 写的是 `^1.15.0`
—— **范围太松，会放进 1.19.0**，所以必须手动钉死：

```json
"@qdrant/js-client-rest": "~1.18.0"
```

`~1.18.0` 只允许 1.18.x，不会漂到 1.19。已验证：1.18.0 / 1.17 / 1.16 / 1.15 都有 `search`，1.19.0 没有。

**顺带**：1.18.0 要 `undici@^6.24.0`，而仓库根 `node_modules` 里是 `undici@7.30.0`
（被其他 chapter 的依赖提升的）。本项目 `node_modules` 里已放了一份 `undici@6.29.0`，
会优先命中，不用管。若以后重装依赖，注意别把这份覆盖掉。


---

## 顺手修掉的 5 个原有问题

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/middleware.js:61` | `rateLimit(req)` 漏了 `await`，async 函数永远返回 Promise，`instanceof NextResponse` 恒为 false → **限流从来没生效过** |
| 2 | `src/middleware.js:31` | 用 `request.ip` 取 IP，但 App Router 的 Request 上没有这个属性 → 永远回退成 `'127.0.0.1'`，所有用户共用一个限流桶。已改为读 `x-forwarded-for` |
| 3 | `src/app/api/route.js:46-57` | `if (!userId)` 重复写了两遍 |
| 4 | `src/app/api/upload/route.js` | `updateDocumentChunkCount` 导出了却从没调用 → 文档列表的分块数一直是空的。已补上 |
| 5 | `src/middleware.js:47` | `securityHeaders` 定义了但从未被调用（死代码）。已接上 |

**另外还有一个没修、但你应该知道的问题：**

`src/lib/documentProcessing.js` 的 `processDocx()` 用 `fs.readFile(path, 'utf8')`
读 `.docx` —— 而 docx 本质是 zip 二进制包，读出来是乱码。
项目已经装了 `docx-parser` 依赖却没用上。**DOCX 上传目前是坏的。**

---

## 回滚

```bash
git checkout .
git clean -fd src/lib/redis.js src/lib/vectorStore.js
npm install @upstash/redis @upstash/ratelimit @upstash/vector
```
