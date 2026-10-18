import { redis } from '@/lib/redis';

/**
 * 评测集存储（按知识库）。
 *
 * 为什么放 Redis 而不是继续用文件：
 *   1. 每个库的语料不同，测试集天然是「库的属性」，不是「项目的属性」
 *   2. 页面上传要立刻生效，写文件在多实例部署下不成立
 *   3. 文件版本保留在 eval/golden.jsonl 作为「内置示例」，新库没有上传时用它
 *
 * 键：eval:golden:{kbId} → JSON 字符串（数组）
 */

const key = (kbId) => `eval:golden:${kbId}`;
export const MAX_CASES = 500;

export async function getGolden(kbId) {
  const raw = await redis.get(key(kbId));
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

export async function saveGolden(kbId, cases) {
  await redis.set(key(kbId), JSON.stringify(cases));
  return cases.length;
}

export async function clearGolden(kbId) {
  await redis.del(key(kbId));
}

// ───────────────────────── 解析与校验 ─────────────────────────

const TIERS = ['easy', 'hard', 'unanswerable'];

/** 极简 CSV 解析：支持双引号包裹、引号内逗号与换行 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const splitList = (v) =>
  String(v ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

const toBool = (v) => ['1', 'true', 'yes', 'y', '是', 'true'].includes(String(v ?? '').trim().toLowerCase());

/**
 * 把一行原始数据规整成标准 case。
 * 返回 { ok: true, value } 或 { ok: false, error }
 */
export function normalizeCase(raw, index) {
  const question = String(raw.question ?? '').trim();
  if (!question) return { ok: false, error: `第 ${index + 1} 条缺少 question` };

  // gold 支持字符串数组或 [{quote}] 两种写法
  let gold = [];
  if (Array.isArray(raw.gold)) {
    gold = raw.gold
      .map((g) => (typeof g === 'string' ? { quote: g } : { quote: String(g?.quote ?? '').trim() }))
      .filter((g) => g.quote);
  } else if (typeof raw.gold_quotes === 'string' || typeof raw.gold === 'string') {
    gold = splitList(raw.gold_quotes ?? raw.gold).map((quote) => ({ quote }));
  }

  const shouldRefuse = toBool(raw.should_refuse);
  let tier = String(raw.tier ?? '').trim().toLowerCase();
  if (!TIERS.includes(tier)) tier = shouldRefuse ? 'unanswerable' : 'easy';

  const mustContain = Array.isArray(raw.must_contain)
    ? raw.must_contain.map((s) => String(s).trim()).filter(Boolean)
    : splitList(raw.must_contain);

  return {
    ok: true,
    value: {
      id: String(raw.id ?? `q${String(index + 1).padStart(3, '0')}`),
      tier,
      question,
      gold,
      must_contain: mustContain,
      should_refuse: shouldRefuse,
    },
  };
}

/** 解析上传内容：按文件名/内容嗅探 JSONL 或 CSV */
export function parseGoldenFile(text, filename = '') {
  const trimmed = text.trim();
  if (!trimmed) return { cases: [], errors: ['文件是空的'] };

  const isJsonl =
    /\.jsonl$/i.test(filename) || (trimmed.startsWith('{') && trimmed.split('\n').length >= 1 && !/^[^\n]*question[,\t]/.test(trimmed));

  const rows = [];
  const errors = [];

  if (isJsonl) {
    trimmed.split('\n').forEach((line, i) => {
      const l = line.trim();
      if (!l) return;
      try {
        rows.push(JSON.parse(l));
      } catch {
        errors.push(`第 ${i + 1} 行不是合法 JSON`);
      }
    });
  } else {
    const table = parseCsv(trimmed);
    if (table.length < 2) return { cases: [], errors: ['CSV 至少需要表头 + 1 行数据'] };
    const header = table[0].map((h) => h.trim().toLowerCase());
    const need = ['question'];
    for (const n of need) {
      if (!header.includes(n)) return { cases: [], errors: [`CSV 缺少必需列：${n}`] };
    }
    table.slice(1).forEach((cells) => {
      const obj = {};
      header.forEach((h, i) => {
        obj[h] = cells[i] ?? '';
      });
      rows.push(obj);
    });
  }

  const cases = [];
  rows.forEach((raw, i) => {
    const { ok, value, error } = normalizeCase(raw, i);
    if (ok) cases.push(value);
    else errors.push(error);
  });

  if (cases.length > MAX_CASES) {
    errors.push(`最多 ${MAX_CASES} 条，当前 ${cases.length} 条，只保留前 ${MAX_CASES} 条`);
    cases.length = MAX_CASES;
  }

  return { cases, errors };
}

/** 给页面用的格式说明 + 示例（前端「下载模板」用） */
export const GOLDEN_TEMPLATE_CSV = [
  'question,tier,gold_quotes,must_contain,should_refuse',
  '"业务设备里 data_type=3 代表什么？",easy,"3 具体服务器（有 device_ip）",服务器,false',
  '"地市字段可以用来做过滤条件吗？",hard,"任何一层都不用它过滤",,false',
  '"这个系统的日活用户数是多少？",unanswerable,,,true',
].join('\n');
