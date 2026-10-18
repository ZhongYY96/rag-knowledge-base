/**
 * 时间字段格式化 —— 全站统一走这里。
 *
 * ── 为什么需要它 ──
 * database.js 写入时用的是 Date.now()（number），
 * 但 Redis 的 hash 只能存字符串，读出来就变成 "1792056311510"。
 *
 * 这时候如果直接写 new Date("1792056311510")，JS 会把它当成**日期字符串**
 * 去解析（而不是毫秒时间戳），结果是 Invalid Date —— 界面上就显示成
 * 「更新于 Invalid Date」。必须先转成数字：new Date(Number(...))。
 *
 * 这个函数两种都兼容：
 *   number / 数字字符串 → new Date(Number(v))
 *   ISO 字符串          → new Date(v)     （Number("2025-01-01") 是 NaN，会落到这个分支）
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;

  const asNumber = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(asNumber) ? new Date(asNumber) : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/** 只显示日期：2026/10/15 */
export function formatDate(value, fallback = '—') {
  const date = toDate(value);
  return date ? date.toLocaleDateString('zh-CN') : fallback;
}

/** 日期 + 时间：2026/10/15 15:04:32 */
export function formatDateTime(value, fallback = '—') {
  const date = toDate(value);
  return date ? date.toLocaleString('zh-CN') : fallback;
}

/** 文件大小：15937 → 15.6 KB */
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** 文件类型的中文标签。表格里直接显示 MIME（application/pdf）对用户没意义 */
const FILE_TYPE_LABELS = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/msword': 'Word',
  'text/plain': '纯文本',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
};

export function fileTypeLabel(mime) {
  if (!mime) return '未知';
  // 认不出来的类型就原样显示，总比显示「未知」有用
  return FILE_TYPE_LABELS[mime] ?? mime;
}
