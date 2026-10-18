import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '@/lib/config';
// ⚠️ 必须用 @langchain/community 里的这一个，不要装独立的 @langchain/qdrant：
//    后者 1.x 的 peerDependency 是 @langchain/core ^1.1.47，
//    而本项目锁在 @langchain/core 0.3.x（0.3.80），大版本不兼容。
//    community 0.3.53 自带的这个虽然标了 @deprecated，但两者 API 完全一致，
//    等整个项目升到 LangChain 1.x 后改成 `from '@langchain/qdrant'` 即可。
import { QdrantVectorStore } from '@langchain/community/vectorstores/qdrant';
import { OpenAIEmbeddings } from '@langchain/openai';
import { Document } from '@langchain/core/documents';
import { randomUUID } from 'node:crypto';
import { toSparse, querySparse } from '@/lib/rag/lexical';

/**
 * 向量层。一个知识库一个 collection，两种形态：
 *
 *   legacy（旧）：单路匿名向量 { size, distance } —— 只能纯向量检索
 *   hybrid（新）：命名向量 { dense, sparse }     —— 向量 + 关键词双路，RRF 融合
 *
 * 对调用方保持同一个契约：getVectorStore(...) 返回的对象都有
 *   addDocuments(docs)
 *   similaritySearchWithScore(query, k)
 * 所以 chat / 评测 / CLI 都不需要知道底层是哪种。
 *
 * 旧库不会被自动改写：要么纯向量继续用，要么跑 scripts/reindex.mjs 重建。
 */

const QDRANT_URL = config.qdrant.url;
const QDRANT_API_KEY = config.qdrant.apiKey || undefined;

const globalForQdrant = globalThis;

export const qdrant =
  globalForQdrant.__qdrantClient ??
  new QdrantClient({
    url: QDRANT_URL,
    ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForQdrant.__qdrantClient = qdrant;
}

export const collectionFor = (knowledgeBaseId) => `kb_${knowledgeBaseId}`;

/** 默认检索策略（与 lib/settings.js 的默认值保持一致） */
export const DEFAULT_RAG = {
  mode: 'dense', // 与 lib/settings.js 一致：当前语料下 dense 更稳
  fusion: 'rrf',
  rrfK: 60,
  denseWeight: 0.7,
  sparseWeight: 0.3,
  multiplier: 4,
};

export function getEmbeddings({ baseUrl, apiKey, model }) {
  return new OpenAIEmbeddings({
    apiKey: apiKey || 'local',
    model,
    configuration: { baseURL: baseUrl },
  });
}

// ───────────────────────── collection 形态判定 ─────────────────────────

const known = new Map(); // name -> { kind: 'hybrid'|'legacy', size }

async function describe(name) {
  if (known.has(name)) return known.get(name);
  try {
    const info = await qdrant.getCollection(name);
    const vectors = info?.config?.params?.vectors;
    // 命名向量是对象映射（{ dense: { size } }），匿名向量是 { size, distance }
    const isNamed = vectors && typeof vectors === 'object' && vectors.dense !== undefined;
    const desc = {
      kind: isNamed ? 'hybrid' : 'legacy',
      size: Number(isNamed ? vectors.dense.size : vectors?.size) || null,
    };
    known.set(name, desc);
    return desc;
  } catch {
    return null;
  }
}

async function createHybridCollection(name, size) {
  await qdrant.createCollection(name, {
    vectors: { dense: { size, distance: 'Cosine' } },
    sparse_vectors: { sparse: {} },
  });
  await qdrant.createPayloadIndex(name, {
    field_name: 'metadata.documentId',
    field_schema: 'keyword',
    wait: true,
  });
  known.set(name, { kind: 'hybrid', size });
}

// ───────────────────────── 混合检索适配器 ─────────────────────────

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
const cosine = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b));
};

function makeHybridStore(name, embeddings, vectorSize, rag) {
  return {
    capabilities: { hybrid: true, mode: 'hybrid' },

    async addDocuments(docs) {
      const vectors = await embeddings.embedDocuments(docs.map((d) => d.pageContent));
      const points = docs.map((doc, i) => ({
        id: randomUUID(),
        vector: {
          dense: vectors[i],
          sparse: toSparse(doc.pageContent),
        },
        payload: { pageContent: doc.pageContent, metadata: doc.metadata ?? {} },
      }));
      await qdrant.upsert(name, { wait: true, points });
    },

    /**
     * 混合检索：dense + sparse 两路 prefetch → RRF/DBSF 融合。
     *
     * 注意返回的 score 是**向量余弦**，不是融合分：
     *   - 排序用融合分（这才是混合的意义）
     *   - 分数回传余弦，是为了让「相似度阈值」这个设置继续有意义
     *     （RRF 分数是 1/(k+rank) 量级，拿阈值去卡它会把结果全过滤掉）
     */
    async similaritySearchWithScore(query, k = 5) {
      const dense = await embeddings.embedQuery(query);
      const sparse = querySparse(query);

      const limit = Math.max(k, k * (Number(rag?.multiplier) || DEFAULT_RAG.multiplier));

      // 纯向量模式：一个开关就能退回 dense-only，方便排查与对照评测
      if (rag?.mode === 'dense') {
        const res = await qdrant.query(name, {
          query: dense,
          using: 'dense',
          limit: k,
          with_payload: true,
          with_vector: ['dense'],
        });
        return (res.points ?? []).map((p, i) => {
          const payload = p.payload ?? {};
          const vec = Array.isArray(p.vector?.dense) ? p.vector.dense : null;
          const denseScore = vec ? cosine(dense, vec) : Number(p.score) || 0;
          return [
            new Document({
              pageContent: payload.pageContent ?? '',
              metadata: {
                ...(payload.metadata ?? {}),
                retrieval: { mode: 'dense', fusion: null, rank: i + 1, fusedScore: denseScore, denseScore },
              },
            }),
            denseScore,
          ];
        });
      }

      const fusion =
        rag?.fusion === 'dbsf'
          ? { fusion: 'dbsf' }
          : {
              // ⚠️ 必须显式给 k：Qdrant 的 RRF 默认 k=2，等于「赢者通吃」
              rrf: {
                k: Number(rag?.rrfK) || DEFAULT_RAG.rrfK,
                weights: [
                  Number(rag?.denseWeight) ?? DEFAULT_RAG.denseWeight,
                  Number(rag?.sparseWeight) ?? DEFAULT_RAG.sparseWeight,
                ],
              },
            };

      const res = await qdrant.query(name, {
        prefetch: [
          { query: dense, using: 'dense', limit },
          { query: sparse, using: 'sparse', limit },
        ],
        query: fusion,
        limit: k,
        with_payload: true,
        with_vector: ['dense'],
      });

      return (res.points ?? []).map((p, i) => {
        const payload = p.payload ?? {};
        const vec = Array.isArray(p.vector?.dense) ? p.vector.dense : null;
        const denseScore = vec ? cosine(dense, vec) : Number(p.score) || 0;
        const doc = new Document({
          pageContent: payload.pageContent ?? '',
          metadata: {
            ...(payload.metadata ?? {}),
            // 排名信息随 metadata 传下去，界面才能说清「第几名、怎么来的」
            retrieval: {
              mode: 'hybrid',
              fusion: rag?.fusion === 'dbsf' ? 'dbsf' : 'rrf',
              rank: i + 1,
              fusedScore: Number(p.score) || 0,
              denseScore,
            },
          },
        });
        return [doc, denseScore];
      });
    },
  };
}

// ───────────────────────── 对外入口 ─────────────────────────

/**
 * 用法不变，只是多了可选的 rag 参数：
 *   getVectorStore(kbId, embedding)        // 写入 / 兼容旧调用
 *   getVectorStore(kbId, embedding, rag)   // 检索时带上策略
 */
export async function getVectorStore(knowledgeBaseId, embedding, rag = DEFAULT_RAG) {
  const { baseUrl, apiKey, model } = embedding || {};
  const vectorSize = Number(embedding?.vectorSize);
  if (!baseUrl || !model || !vectorSize) {
    throw new Error('embedding 配置不完整（需要 baseUrl / model / vectorSize）');
  }

  const name = collectionFor(knowledgeBaseId);
  const embeddings = getEmbeddings({ baseUrl, apiKey, model });

  let desc = await describe(name);

  if (!desc) {
    await createHybridCollection(name, vectorSize);
    desc = { kind: 'hybrid', size: vectorSize };
  }

  if (desc.size && desc.size !== vectorSize) {
    throw new Error(
      `知识库索引的向量维度是 ${desc.size}，当前 embedding 配置是 ${vectorSize}。` +
        '换 embedding 模型后，老知识库需要重新上传文档（或跑 scripts/reindex.mjs）。',
    );
  }

  // 旧库：继续用 LangChain 的实现（纯向量），不强行改写用户数据
  if (desc.kind === 'legacy') {
    const store = await QdrantVectorStore.fromExistingCollection(embeddings, {
      client: qdrant,
      collectionName: name,
      collectionConfig: { vectors: { size: vectorSize, distance: 'Cosine' } },
    });
    store.capabilities = { hybrid: false, mode: 'dense' };
    return store;
  }

  return makeHybridStore(name, embeddings, vectorSize, rag);
}

/** 这个库支持混合检索吗（页面/接口给用户看的） */
export async function getCollectionKind(knowledgeBaseId) {
  const desc = await describe(collectionFor(knowledgeBaseId));
  return desc ? desc.kind : 'missing';
}

export async function deleteDocumentVectors(knowledgeBaseId, documentId) {
  const name = collectionFor(knowledgeBaseId);
  try {
    await qdrant.delete(name, {
      wait: true,
      filter: { must: [{ key: 'metadata.documentId', match: { value: documentId } }] },
    });
  } catch (error) {
    console.warn(`[vectorStore] 删除向量失败 ${name}/${documentId}:`, error.message);
  }
}

export async function dropKnowledgeBaseVectors(knowledgeBaseId) {
  const name = collectionFor(knowledgeBaseId);
  try {
    await qdrant.deleteCollection(name);
  } catch (error) {
    console.warn(`[vectorStore] 删除集合失败 ${name}:`, error.message);
  } finally {
    known.delete(name);
  }
}
