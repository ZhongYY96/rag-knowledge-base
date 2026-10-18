#!/usr/bin/env node
/**
 * RAG 评测 CLI —— 判定逻辑全部来自 src/lib/rag/eval.js（与页面共用同一份内核）。
 *
 * 用法：
 *   node scripts/eval.mjs --retrieval-only     # 只跑检索层，几秒
 *   node scripts/eval.mjs                      # 全链路（检索 + 生成）
 *   node scripts/eval.mjs --limit 3
 *   node scripts/eval.mjs --tier unanswerable
 *   node scripts/eval.mjs --kb kb_xxx --user user_xxx
 *
 * 说明：管理员 CLI，绕过登录鉴权，直接读 Redis/Qdrant。
 * Node 无法 import 带 `@/` 别名的应用模块，脚本会把用到的几个文件复制进
 * .eval-tmp/ 并改写成相对路径，跑完删除。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const RETRIEVAL_ONLY = arg('retrieval-only', false) === true;
const LIMIT = Number(arg('limit', 0)) || 0;
const GOLDEN = path.resolve(ROOT, String(arg('file', 'eval/golden.jsonl')));
const ONLY_TIER = arg('tier', null);

const STAGE = path.join(ROOT, '.eval-tmp');
const MODULES = [
  ['src/lib/config.js', 'config.mjs'],
  ['src/lib/jobHeartbeat.js', 'jobheartbeat.mjs'],
  ['src/lib/redis.js', 'redis.mjs'],
  ['src/lib/database.js', 'database.mjs'],
  ['src/lib/settings.js', 'settings.mjs'],
  ['src/lib/vectorStore.js', 'vectorStore.mjs'],
  ['src/lib/rag/prompt.js', 'prompt.mjs'],
  ['src/lib/rag/eval.js', 'evalcore.mjs'],
  ['src/lib/rag/goldenStore.js', 'goldenstore.mjs'],
  ['src/lib/rag/lexical.js', 'lexical.mjs'],
];

async function stageModules() {
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  for (const [from, to] of MODULES) {
    let code = await readFile(path.join(ROOT, from), 'utf8');
    code = code.replace(/from '@\/lib\/([\w\-/]+)'/g, (_m, p) => `from './${p.split('/').pop()}.mjs'`);
    code = code.replace(/from '\.\/([\w-]+)'/g, (_m, p) => `from './${p}.mjs'`);
    await writeFile(path.join(STAGE, to), code);
  }
}

const load = (f) => import(pathToFileURL(path.join(STAGE, f)).href);
const pad = (s, n) => String(s).padEnd(n);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

async function main() {
  await stageModules();
  const { redis } = await load('redis.mjs');
  const settingsMod = await load('settings.mjs');
  const vsMod = await load('vectorStore.mjs');
  const promptMod = await load('prompt.mjs');
  const core = await load('evalcore.mjs');
  const goldenStore = await load('goldenstore.mjs');

  let userId = arg('user', null);
  if (!userId) {
    const ids = await redis.smembers('users');
    if (ids.length !== 1) throw new Error(`用户有 ${ids.length} 个，请用 --user 指定：${ids.join(', ') || '（无）'}`);
    userId = ids[0];
  }

  let kbId = arg('kb', null);
  if (!kbId) {
    const kbs = await redis.smembers(`user:${userId}:kbs`);
    if (kbs.length !== 1) throw new Error(`知识库有 ${kbs.length} 个，请用 --kb 指定：${kbs.join(', ') || '（无）'}`);
    kbId = kbs[0];
  }

  const kb = await redis.hgetall(`knowledgebase_${kbId}`);
  const settings = await settingsMod.getSettings(userId);
  const chat = settingsMod.chatConfig(settings);
  const embedding = await settingsMod.embeddingConfigForKb(kbId, settings);
  const rag = settingsMod.ragConfig(settings);

  // 对照实验用：命令行覆盖检索策略，不写回用户设置
  const modeOverride = arg('mode', null);
  const weightsOverride = arg('weights', null);
  if (modeOverride) rag.mode = modeOverride === 'dense' ? 'dense' : 'hybrid';
  const topkOverride = Number(arg('topk', 0));
  if (topkOverride > 0) rag.topK = Math.max(1, Math.min(20, topkOverride));
  if (weightsOverride) {
    const [dw, sw] = String(weightsOverride).split(',').map(Number);
    if (Number.isFinite(dw)) rag.denseWeight = dw;
    if (Number.isFinite(sw)) rag.sparseWeight = sw;
  }

  console.log(`\n知识库 : ${kb.name || kbId}  (${kbId})`);
  console.log(
    `配置   : ${rag.mode}${rag.mode === 'hybrid' ? `/${rag.fusion} k=${rag.rrfK} w=${rag.denseWeight}:${rag.sparseWeight}` : ''}` +
      ` topK=${rag.topK} 阈值=${rag.scoreThreshold} chunk=${rag.chunkSize}/${rag.chunkOverlap}`,
  );
  console.log(`模型   : ${chat.model} @ ${chat.baseUrl}`);
  console.log(`向量   : ${embedding.model} (${embedding.vectorSize} 维)`);
  console.log(`模式   : ${RETRIEVAL_ONLY ? '仅检索层' : '检索 + 生成'}`);

  // 优先用页面上传的测试集；没有则用文件（--file 可指定）
  const uploaded = await goldenStore.getGolden(kbId);
  let cases = uploaded ?? (await core.loadGolden(GOLDEN));
  if (uploaded) console.log(`测试集 : 页面上传的 ${uploaded.length} 条（忽略 --file）`);
  if (ONLY_TIER) cases = cases.filter((c) => c.tier === ONLY_TIER);
  if (LIMIT) cases = cases.slice(0, LIMIT);
  console.log(`样本   : ${cases.length} 条\n`);

  const store = await vsMod.getVectorStore(kbId, embedding, rag);

  let chain = null;
  if (!RETRIEVAL_ONLY) {
    const { ChatOpenAI } = await import('@langchain/openai');
    const llm = new ChatOpenAI({
      apiKey: chat.apiKey || 'local',
      configuration: { baseURL: chat.baseUrl },
      model: chat.model,
      temperature: 0,
      maxTokens: chat.maxTokens,
      streaming: false,
    });
    chain = promptMod.buildAnswerChain(llm);
  }

  const results = [];
  for (const [i, c] of cases.entries()) {
    const started = Date.now();
    const hits = await store.similaritySearchWithScore(c.question, rag.topK);
    const retrieval = core.judgeRetrieval({
      hits,
      gold: c.gold,
      topK: rag.topK,
      scoreThreshold: rag.scoreThreshold,
    });

    const row = {
      id: c.id,
      tier: c.tier,
      question: c.question,
      shouldRefuse: c.should_refuse === true,
      ...retrieval,
    };

    if (!RETRIEVAL_ONLY) {
      const docs = hits.map(([doc]) => doc);
      const { answer } = await promptMod.answerFromDocs({
        chain,
        docs,
        query: c.question,
        chatHistory: [],
      });
      row.answer = answer;
      Object.assign(
        row,
        core.judgeAnswer({
          answer,
          docs,
          shouldRefuse: row.shouldRefuse,
          mustContain: c.must_contain,
        }),
      );
    }

    row.ms = Date.now() - started;
    results.push(row);
    console.log(
      `  [${String(i + 1).padStart(2)}/${cases.length}] ${c.tier.padEnd(12)} ${c.question.slice(0, 26)}` +
        `  hit=${retrieval.hitAtK}` +
        (RETRIEVAL_ONLY ? '' : ` 引用=${row.citations} 拒答=${row.refused}`),
    );
  }

  const tiers = core.summarize(results);

  console.log('\n' + '─'.repeat(78));
  console.log(
    pad('档位', 14) + pad('样本', 6) + pad('命中@K', 9) + pad('Recall', 9) + pad('引用正确', 10) +
      pad('拒答率', 9) + pad('误拒率', 9) + pad('P0', 4),
  );
  for (const [t, a] of Object.entries(tiers)) {
    console.log(
      pad(t, 14) + pad(a.n, 6) + pad(pct(a.hitAtK), 9) + pad(pct(a.recall), 9) +
        pad(pct(a.citationOk), 10) + pad(pct(a.refusal), 9) +
        pad(pct(a.falseRefusal), 9) + pad(a.p0, 4),
    );
  }
  console.log('─'.repeat(78));

  const failures = core.failuresOf(results);
  if (failures.length) {
    console.log('\n失败样本（前 10）');
    for (const f of failures.slice(0, 10)) {
      const why = [];
      if (f.hitAtK === false) why.push(`检索未命中（最佳 ${(Math.max(0, ...f.goldBest.map((g) => g.best)) * 100).toFixed(0)}%）`);
      if (f.p0) why.push('P0 错误');
      if (f.empty) why.push('空回答');
      else if (f.citations === 0 && f.shouldRefuse !== true) why.push('无引用');
      console.log(`  · [${f.id}] ${f.question}\n    原因：${why.join(' / ')}`);
      if (f.answer) console.log(`    回答：${f.answer.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }

  const file = await core.saveReport({
    at: new Date().toISOString(),
    kbId,
    kbName: kb.name,
    mode: RETRIEVAL_ONLY ? 'retrieval-only' : 'full',
    source: 'cli',
    config: { ...rag, chat: { model: chat.model, baseUrl: chat.baseUrl }, embedding },
    tiers,
    results,
  });
  console.log(`\n报告：${path.relative(ROOT, file)}`);

  await rm(STAGE, { recursive: true, force: true });
  await redis.quit();
}

main().catch(async (e) => {
  console.error('\n评测失败：', e.message);
  try {
    await rm(STAGE, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
