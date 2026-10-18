import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 评测内核：判定规则 + 汇总 + 报告读写。
 *
 * 一份内核，两个入口：
 *   - scripts/eval.mjs（CLI，可跑全链路，用于 CI/回归）
 *   - /api/eval/run（页面按钮，只跑检索层，秒回）
 * 两边算出来的指标必须一致，否则页面上的数字就是假的。
 */

// ───────────────────────── 判定规则 ─────────────────────────

/** 去空白与常见标点/装饰符，避免格式差异影响比对 */
export const norm = (s) =>
  String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：""''（）()【】《》\-—·…!?！？*`#]/g, '');

/** 字符二元组覆盖率：quote 的 bigram 有多少出现在 chunk 里 */
export function overlapRatio(chunk, quote) {
  const a = norm(chunk);
  const b = norm(quote);
  if (!b) return 0;
  if (a.includes(b)) return 1;
  const grams = new Set();
  for (let i = 0; i < b.length - 1; i++) grams.add(b.slice(i, i + 2));
  if (grams.size === 0) return 0;
  let hit = 0;
  for (const g of grams) if (a.includes(g)) hit++;
  return hit / grams.size;
}

/**
 * 最长公共子串长度 / 断言长度。
 *
 * 为什么需要它：断言里常混着问题的措辞（「业务设备里 data_type=3 代表…」），
 * 而引用块里只有原文（「3 具体服务器（有 device_ip）」）。纯 bigram 覆盖率
 * 会被问题措辞稀释到 0.4 以下，把正确引用误判成不支持。
 */
export function lcsRatio(rawA, rawB) {
  const a = norm(rawA);
  const b = norm(rawB);
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best / a.length;
}

export const CITATION_RE = /\[citation:(\d+)\]/g;
export const REFUSAL_RE =
  /(没有|未提及|未包含|不包含|无法|找不到|文档中没|没有提到|未找到|not mentioned|no information|cannot find|can't find|do not contain)/i;

export const splitClaims = (text) =>
  String(text ?? '')
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

export const numbersIn = (s) => String(s ?? '').match(/\d+(?:\.\d+)?/g) || [];

/** 断言是否被被引用的块支撑：数字全等（硬规则）+ 支撑度阈值 */
export function judgeClaim(claim, citedChunks) {
  const nums = numbersIn(claim.replace(CITATION_RE, ''));
  const numbersOk = nums.every((n) => citedChunks.some((c) => String(c).includes(n)));
  const score = citedChunks.reduce(
    (max, c) => Math.max(max, overlapRatio(c, claim), lcsRatio(claim, c)),
    0,
  );
  return { supported: numbersOk && score >= 0.35, numbersOk, score };
}

/**
 * 生成层判定。返回的字段直接拼进 report 的一行。
 * 拒答 / 空回答不参与引用正确率统计（否则指标被污染）。
 */
export function judgeAnswer({ answer, docs, shouldRefuse, mustContain }) {
  const claims = splitClaims(answer);
  const empty = String(answer ?? '').trim().length === 0;

  // 引用继承：没有引用的句子，若后面 3 句内出现引用就继承它
  const claimCites = claims.map((cl) => [...cl.matchAll(CITATION_RE)].map((m) => Number(m[1])));
  let inheritedCitations = 0;
  for (let i = 0; i < claims.length; i++) {
    if (claimCites[i].length) continue;
    for (let j = i + 1; j <= Math.min(i + 3, claims.length - 1); j++) {
      if (claimCites[j].length) {
        claimCites[i] = claimCites[j];
        inheritedCitations++;
        break;
      }
    }
  }

  let unsupported = 0;
  let numberMismatch = 0;
  let noCitation = 0;
  let totalCitations = 0;
  let supportedCitations = 0;

  for (const [k, claim] of claims.entries()) {
    const idx = claimCites[k];
    if (idx.length === 0) {
      if (numbersIn(claim).length > 0 || claim.length > 15) noCitation++;
      unsupported++;
      continue;
    }
    const citedChunks = idx.map((n) => docs[n - 1]?.pageContent).filter((x) => typeof x === 'string');
    totalCitations += idx.length;
    const verdict = judgeClaim(claim, citedChunks);
    if (verdict.supported) supportedCitations += idx.length;
    if (!verdict.supported) unsupported++;
    if (!verdict.numbersOk) numberMismatch++;
  }

  const refusals = REFUSAL_RE.test(answer);
  const gaveAnswer = totalCitations > 0;
  const refused = refusals && !gaveAnswer;

  return {
    claims: claims.length,
    citations: totalCitations,
    inheritedCitations,
    unsupported,
    noCitation,
    numberMismatch,
    empty,
    refused,
    citationOk: totalCitations ? supportedCitations / totalCitations : null,
    correctRefusal: shouldRefuse ? refused : null,
    falseRefusal: shouldRefuse === false ? refused : null,
    mustContainOk:
      Array.isArray(mustContain) && mustContain.length
        ? mustContain.every((k) => norm(answer).includes(norm(k)))
        : null,
    p0: (shouldRefuse === true && !refused) || numberMismatch > 0,
  };
}

// ───────────────────────── 检索层 ─────────────────────────

/** 跑一条样本的检索判定 */
export function judgeRetrieval({ hits, gold, topK, scoreThreshold = 0 }) {
  const chunks = hits
    .map(([doc, score]) => ({ text: doc.pageContent, score }))
    .filter((x) => scoreThreshold <= 0 || x.score >= scoreThreshold);

  const goldBest = (gold || []).map((g) => ({
    quote: g.quote,
    best: chunks.reduce((m, ch) => Math.max(m, overlapRatio(ch.text, g.quote)), 0),
  }));

  return {
    retrieved: chunks.length,
    hitAtK: goldBest.length ? goldBest.some((g) => g.best >= 0.6) : null,
    recall: goldBest.length ? goldBest.filter((g) => g.best >= 0.6).length / goldBest.length : null,
    goldBest,
  };
}

// ───────────────────────── 汇总 ─────────────────────────

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

export function summarize(results) {
  const out = {};
  for (const tier of ['easy', 'hard', 'unanswerable']) {
    const rows = results.filter((r) => r.tier === tier);
    if (!rows.length) continue;

    const withGold = rows.filter((r) => r.hitAtK != null);
    const answerable = rows.filter((r) => r.shouldRefuse !== true);
    const unanswerable = rows.filter((r) => r.shouldRefuse === true);
    const withCite = rows.filter((r) => r.citationOk != null);
    // 只跑检索层时没有生成结果，拒答相关指标应为「无数据」而不是 0%
    const hasRefusalData = rows.some((r) => r.refused !== undefined);

    out[tier] = {
      n: rows.length,
      hitAtK: withGold.length ? withGold.filter((r) => r.hitAtK).length / withGold.length : null,
      recall: withGold.length ? avg(withGold.map((r) => r.recall)) : null,
      citationOk: withCite.length ? avg(withCite.map((r) => r.citationOk)) : null,
      refusal:
        hasRefusalData && unanswerable.length
          ? unanswerable.filter((r) => r.correctRefusal).length / unanswerable.length
          : null,
      falseRefusal:
        hasRefusalData && answerable.length
          ? answerable.filter((r) => r.falseRefusal).length / answerable.length
          : null,
      p0: rows.filter((r) => r.p0).length,
      empty: rows.filter((r) => r.empty).length,
    };
  }
  return out;
}

/** 失败样本：检索没命中 / P0 / 空回答 / 该答却没引用 */
export const failuresOf = (results) =>
  results.filter(
    (r) => r.hitAtK === false || r.p0 || r.empty || (r.citations === 0 && r.shouldRefuse !== true),
  );

// ───────────────────────── golden set ─────────────────────────

const GOLDEN_FILE = path.join(process.cwd(), 'eval', 'golden.jsonl');

export async function loadGolden(file = GOLDEN_FILE) {
  const raw = await readFile(file, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`golden.jsonl 第 ${i + 1} 行不是合法 JSON：${e.message}`);
      }
    });
}

// ───────────────────────── 报告读写 ─────────────────────────

const REPORTS_DIR = path.join(process.cwd(), 'eval', 'reports');

export async function saveReport(report) {
  await mkdir(REPORTS_DIR, { recursive: true });
  // 精确到毫秒：对照实验常常同一秒跑两次，秒级时间戳会互相覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const file = path.join(REPORTS_DIR, `eval-${stamp}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

/** 取某个知识库最新的一份报告；没有就返回 null */
export async function latestReport(kbId) {
  let files;
  try {
    files = (await readdir(REPORTS_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(path.join(REPORTS_DIR, f), 'utf8'));
      if (!kbId || data.kbId === kbId) return { ...data, file: f };
    } catch {
      // 坏文件跳过
    }
  }
  return null;
}
