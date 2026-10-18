import { redis, isMissingHash } from './redis';
import { getKnowledgeBase } from './database';

/**
 * 模型配置。
 *
 * 范围：**按用户**，存在 Redis 的 `settings:{userId}`。
 * 为什么按用户而不是全局：这套 demo 允许每个人填自己的 vendor / key，
 * 而 key 属于个人凭据，不该被别的账号读到（界面里只回掩码）。
 *
 * 只支持 OpenAI 兼容协议：
 *   chat      → {baseUrl}/chat/completions
 *   embedding → {baseUrl}/embeddings
 * 所以「vendor」不是一条下拉枚举，就是一段 baseUrl —— vLLM、LM Studio、
 * llama.cpp、Ollama(/v1)、DeepSeek、通义、Kimi 全都走这一套。
 */

const DEFAULTS = () => ({
  chatBaseUrl: process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1',
  chatApiKey: process.env.OPENAI_API_KEY || 'local',
  chatModel: process.env.OPENAI_MODEL || 'MiniCPM5-2B',
  chatTemperature: Number(process.env.OPENAI_TEMPERATURE || 0),
  chatMaxTokens: Number(process.env.OPENAI_MAX_TOKENS || 1024),

  embBaseUrl: process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:8001/v1',
  embApiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || 'local',
  embModel: process.env.EMBEDDING_MODEL || 'bge-m3',
  embVectorSize: Number(process.env.QDRANT_VECTOR_SIZE || 1024),

  // ── RAG 检索参数 ──
  // 默认值与改造前写死的值完全一致（5 / 400 / 100 / 不过滤 / 开改写）
  ragTopK: 5, // 每次召回几块
  ragChunkSize: 400, // 切分块大小（字符）
  ragChunkOverlap: 100, // 块间重叠，避免答案被切在边界
  ragScoreThreshold: 0, // 相似度低于它就丢弃；0 = 不启用
  ragQueryRewrite: 1, // 追问是否先改写成独立问题（1 开 / 0 关）

  // ── 混合检索策略 ──
  // 默认 dense：当前语料（2 篇 / 46 块）实测 hybrid 在 hard 档掉召回（100% → 87.5%），
  // 根因是关键词路漏块。语料扩大后再用评测决定是否切回 hybrid。
  ragMode: 'dense', // hybrid：向量 + 关键词双路；dense：只走向量
  ragFusion: 'rrf', // rrf | dbsf（两路结果怎么合并）
  ragRrfK: 60, // RRF 的 k。业界 60，Qdrant 默认 2 —— 必须显式传
  ragDenseWeight: 0.7, // 向量路权重
  ragSparseWeight: 0.3, // 关键词路权重
  ragCandidateMultiplier: 4, // 每路预取 topK × N，再融合
});

const NUMERIC = [
  'chatTemperature',
  'chatMaxTokens',
  'embVectorSize',
  'ragTopK',
  'ragChunkSize',
  'ragChunkOverlap',
  'ragScoreThreshold',
  'ragQueryRewrite',
  'ragRrfK',
  'ragDenseWeight',
  'ragSparseWeight',
  'ragCandidateMultiplier',
];
const URL_FIELDS = ['chatBaseUrl', 'embBaseUrl'];
const SECRET_FIELDS = ['chatApiKey', 'embApiKey'];
const FIELDS = Object.keys(DEFAULTS());

export const settingsKey = (userId) => `settings:${userId}`;

const trimUrl = (u) => String(u).trim().replace(/\/+$/, '');

function coerce(raw) {
  const out = DEFAULTS();
  for (const f of FIELDS) {
    const v = raw?.[f];
    if (v === undefined || v === null || v === '') continue;
    out[f] = NUMERIC.includes(f) ? Number(v) : String(v);
  }
  return out;
}

/** 服务端内部用：明文，含 key */
export async function getSettings(userId) {
  const raw = await redis.hgetall(settingsKey(userId));
  return coerce(isMissingHash(raw) ? {} : raw);
}

/** 回给前端的版本：key 只留掩码 + 是否已配置 */
export function toPublicSettings(s) {
  return {
    ...s,
    chatApiKey: mask(s.chatApiKey),
    embApiKey: mask(s.embApiKey),
    hasChatKey: Boolean(s.chatApiKey),
    hasEmbKey: Boolean(s.embApiKey),
  };
}

export function mask(secret) {
  if (!secret) return '';
  const str = String(secret);
  if (str.length <= 8) return '****';
  return `${str.slice(0, 3)}****${str.slice(-4)}`;
}

/** 校验 + 落库。apiKey 传空字符串表示「不修改」，不会被清空 */
export async function saveSettings(userId, patchBody) {
  const current = await getSettings(userId);
  const next = { ...current };

  for (const f of FIELDS) {
    if (!(f in patchBody)) continue;
    let v = patchBody[f];

    if (SECRET_FIELDS.includes(f)) {
      if (v === undefined || v === null || v === '') continue; // 不修改
      next[f] = String(v).trim();
      continue;
    }

    if (URL_FIELDS.includes(f)) {
      const url = trimUrl(v);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${f} 不是合法 URL`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${f} 只支持 http/https`);
      }
      next[f] = url;
      continue;
    }

    if (NUMERIC.includes(f)) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${f} 必须是数字`);
      next[f] = n;
      continue;
    }

    next[f] = String(v).trim();
  }

  if (!next.chatModel) throw new Error('对话模型名不能为空');
  if (!next.embModel) throw new Error('embedding 模型名不能为空');
  if (next.chatTemperature < 0 || next.chatTemperature > 2) throw new Error('temperature 需在 0~2');
  if (next.chatMaxTokens < 16 || next.chatMaxTokens > 32768) throw new Error('maxTokens 需在 16~32768');
  if (next.embVectorSize < 32 || next.embVectorSize > 8192) throw new Error('向量维度需在 32~8192');

  if (next.ragTopK < 1 || next.ragTopK > 20) throw new Error('召回条数需在 1~20');
  if (next.ragChunkSize < 120 || next.ragChunkSize > 2000) throw new Error('块大小需在 120~2000');
  if (next.ragChunkOverlap < 0 || next.ragChunkOverlap > 500) throw new Error('重叠需在 0~500');
  if (next.ragChunkOverlap >= next.ragChunkSize) throw new Error('重叠必须小于块大小');
  if (next.ragScoreThreshold < 0 || next.ragScoreThreshold > 1) {
    throw new Error('相似度阈值需在 0~1');
  }

  if (!['hybrid', 'dense'].includes(next.ragMode)) throw new Error('检索模式只能是 hybrid 或 dense');
  if (!['rrf', 'dbsf'].includes(next.ragFusion)) throw new Error('融合算法只能是 rrf 或 dbsf');
  if (next.ragRrfK < 1 || next.ragRrfK > 100) throw new Error('RRF k 需在 1~100');
  if (next.ragDenseWeight < 0 || next.ragDenseWeight > 1) throw new Error('向量路权重需在 0~1');
  if (next.ragSparseWeight < 0 || next.ragSparseWeight > 1) {
    throw new Error('关键词路权重需在 0~1');
  }
  if (next.ragDenseWeight + next.ragSparseWeight <= 0) throw new Error('两路权重不能同时为 0');
  if (next.ragCandidateMultiplier < 2 || next.ragCandidateMultiplier > 10) {
    throw new Error('候选倍数需在 2~10');
  }

  await redis.hset(settingsKey(userId), next);
  return next;
}

/** 给 ChatOpenAI 用的配置 */
export const chatConfig = (s) => ({
  baseUrl: s.chatBaseUrl,
  apiKey: s.chatApiKey || 'local',
  model: s.chatModel,
  temperature: Number(s.chatTemperature ?? 0),
  maxTokens: Number(s.chatMaxTokens ?? 1024),
});

/** 给 OpenAIEmbeddings / Qdrant 用的配置 */
export const embeddingConfig = (s) => ({
  baseUrl: s.embBaseUrl,
  apiKey: s.embApiKey || 'local',
  model: s.embModel,
  vectorSize: Number(s.embVectorSize),
});

/** 给检索链路用的 RAG 参数 */
export const ragConfig = (s) => ({
  topK: Math.max(1, Math.min(20, Number(s.ragTopK ?? 5))),
  chunkSize: Math.max(120, Math.min(2000, Number(s.ragChunkSize ?? 400))),
  chunkOverlap: Math.max(0, Math.min(500, Number(s.ragChunkOverlap ?? 100))),
  scoreThreshold: Math.max(0, Math.min(1, Number(s.ragScoreThreshold ?? 0))),
  queryRewrite: String(s.ragQueryRewrite ?? 1) !== '0',

  // 混合检索策略
  mode: s.ragMode === 'dense' ? 'dense' : 'hybrid',
  fusion: s.ragFusion === 'dbsf' ? 'dbsf' : 'rrf',
  rrfK: Math.max(1, Math.min(100, Number(s.ragRrfK ?? 60))),
  denseWeight: Math.max(0, Math.min(1, Number(s.ragDenseWeight ?? 0.7))),
  sparseWeight: Math.max(0, Math.min(1, Number(s.ragSparseWeight ?? 0.3))),
  multiplier: Math.max(2, Math.min(10, Number(s.ragCandidateMultiplier ?? 4))),
});

/**
 * 知识库级的 embedding 解析。
 *
 * ★ 关键设计：embedding 的「模型 + 维度」在建库首次上传时**钉在知识库上**。
 *   之后用户改设置只影响新知识库，老库仍用原来的模型 —— 否则换个 embedding
 *   模型，老索引的向量维度对不上，检索直接废掉。
 *   而 baseUrl / apiKey 永远取当前设置：换服务地址、轮换 key 不需要重建索引。
 */
export async function embeddingConfigForKb(kbId, settings) {
  const cfg = embeddingConfig(settings);
  const kb = await getKnowledgeBase(kbId);
  const model = kb?.embModel;
  const size = Number(kb?.embVectorSize || 0);
  if (model && size) return { ...cfg, model, vectorSize: size };
  return cfg;
}

/** 配置指纹：用来给 RAG 实例做缓存键，设置一改就换新实例 */
export const fingerprint = (c) =>
  `${c.baseUrl}|${c.model}|${c.apiKey ? c.apiKey.slice(-4) : ''}`;
