/**
 * 判断一条消息是不是「追问」。
 *
 * 为什么需要：把完整对话历史塞给模型，弱模型（本地 2B）会**沿用上一轮的实体**
 * 重新回答上一轮的问题。实测：上一轮问「磁盘告警」，这一轮问「某指标上一周的告警」，
 * 带历史时模型原样复述「上下文未包含磁盘告警…」；不带历史时才正确反问「哪个指标」。
 *
 * 所以：只有明确是追问时才带历史。判断标准尽量保守——
 * 宁可少带历史（退化成独立问答），也不要让上一轮的主题污染这一轮。
 */
const FOLLOWUP_PATTERNS = [
  /^(那|这|它|其|上面|刚才|前面|还有|再|继续|然后|接着)/,
  /(呢|吗)[？?]?$/,
  /(上面|刚才|前面|之前)(说的|提到的|那个|这个)/,
];

export function isFollowUp(question) {
  const q = String(question || '').trim();
  if (!q) return false;

  // 带明确指代的问法 → 追问
  if (FOLLOWUP_PATTERNS.some((re) => re.test(q))) return true;

  // 很短的问题（如「整体流程」「具体呢」）单独看没有主语，几乎一定是追问
  if (q.length <= 12) return true;

  return false;
}

/** 追问才带历史，否则当作独立问题 */
export function historyFor(question, history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  return isFollowUp(question) ? history : [];
}
