/**
 * Token 估算（兜底用）。
 *
 * 为什么需要：本地 llama.cpp 的流式响应默认不返回 usage，
 * AI SDK 拿到的 promptTokens/completionTokens 会是 0，
 * 成本就永远是 0。这里按字符构成做量级估算。
 *
 * 口径：CJK 约 1 字 = 0.6 token，其余约 4 字符 = 1 token。
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = s.length - cjk;
  return Math.round(cjk * 0.6 + other / 4);
}
