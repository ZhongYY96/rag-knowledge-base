/**
 * 词法（稀疏向量）工具。
 *
 * 只做两件事：分词、把「词频」变成 Qdrant 能存的稀疏向量。
 * 故意不做 IDF：RRF 融合只看排名不看绝对分数，缺 IDF 不影响融合质量。
 * 严格说这不是完整 BM25，而是在同一套 Qdrant 里补一条「精确串」通道。
 */

const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '或', '有', '个', '我', '你', '他', '它',
  '这', '那', '就', '都', '而', '及', '等', '被', '把', '对', '中', '上', '下',
  'a', 'an', 'the', 'is', 'are', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with',
]);

/** 中文用 Intl.Segmenter 切词（Node 自带 full-icu）；英文/数字按词处理 */
export function tokenize(text) {
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  const out = [];
  for (const { segment, isWordLike } of seg.segment(String(text ?? '').toLowerCase())) {
    if (!isWordLike) continue;
    const t = segment.trim();
    if (!t || STOP.has(t)) continue;
    // 超长数字串（时间戳之类）进索引没意义，反而制造噪声
    if (/^\d+$/.test(t) && t.length > 8) continue;
    out.push(t);
  }
  return out;
}

/** FNV-1a 32 位哈希：Qdrant 稀疏向量的 index 是 uint32 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 文本 → 稀疏向量 { indices, values }
 * 权重用 1 + log(tf)：词频饱和，避免长文本里高频词把分数拉满。
 * 哈希碰撞按 index 累加（同义词/碰撞词合并，影响很小）。
 */
export function toSparse(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return { indices: [], values: [] };

  const tf = new Map();
  for (const t of tokens) {
    const idx = hash32(t);
    tf.set(idx, (tf.get(idx) || 0) + 1);
  }

  const entries = [...tf.entries()].sort((a, b) => a[0] - b[0]);
  return {
    indices: entries.map(([i]) => i),
    values: entries.map(([, n]) => 1 + Math.log(n)),
  };
}

/** 查询侧：每个词权重 1，交给 Qdrant 与文档侧做点积 */
export function querySparse(query) {
  const tokens = tokenize(query);
  const uniq = [...new Set(tokens.map(hash32))].sort((a, b) => a - b);
  return { indices: uniq, values: uniq.map(() => 1) };
}
