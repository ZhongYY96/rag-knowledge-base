#!/usr/bin/env node
/**
 * 把一个知识库从「单路向量」重建成「dense + sparse」混合索引。
 *
 * 为什么需要：Qdrant 的匿名向量（含 size）和命名向量（dense/sparse）不兼容，
 * 加稀疏路只能重建。原文还在 uploads/，所以能重放。
 *
 * 用法：
 *   node scripts/reindex.mjs --dry-run          # 只看会做什么
 *   node scripts/reindex.mjs --yes              # 真跑（会删旧 collection）
 *   node scripts/reindex.mjs --kb kb_xxx --user user_xxx --yes
 *
 * ⚠️ 重建期间该库不可检索（本次是先删后建）。文档数少时只有几秒。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DRY = has('dry-run');
const YES = has('yes');

const STAGE = path.join(ROOT, '.reindex-tmp');
const MODULES = [
  ['src/lib/config.js', 'config.mjs'],
  ['src/lib/jobHeartbeat.js', 'jobheartbeat.mjs'],
  ['src/lib/redis.js', 'redis.mjs'],
  ['src/lib/database.js', 'database.mjs'],
  ['src/lib/settings.js', 'settings.mjs'],
  ['src/lib/vectorStore.js', 'vectorStore.mjs'],
  ['src/lib/rag/lexical.js', 'lexical.mjs'],
  ['src/lib/documentProcessing.js', 'docprocess.mjs'],
];

async function stage() {
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

// ⚠️ 必须在 finally 里关闭 Redis：ioredis 的连接会让事件循环一直活着，
//    任何 early-return（干跑 / 已是混合索引）都会导致进程不退出。
let redisConn = null;

async function main() {
  await stage();
  const { redis } = await load('redis.mjs');
  redisConn = redis;
  const settingsMod = await load('settings.mjs');
  const vsMod = await load('vectorStore.mjs');
  const docMod = await load('docprocess.mjs');
  const { Document } = await import('@langchain/core/documents');

  let userId = val('user');
  if (!userId) {
    const ids = await redis.smembers('users');
    if (ids.length !== 1) throw new Error(`用户有 ${ids.length} 个，请用 --user 指定`);
    userId = ids[0];
  }
  let kbId = val('kb');
  if (!kbId) {
    const kbs = await redis.smembers(`user:${userId}:kbs`);
    if (kbs.length !== 1) throw new Error(`知识库有 ${kbs.length} 个，请用 --kb 指定`);
    kbId = kbs[0];
  }

  const kb = await redis.hgetall(`knowledgebase_${kbId}`);
  const settings = await settingsMod.getSettings(userId);
  const embedding = await settingsMod.embeddingConfigForKb(kbId, settings);
  const rag = settingsMod.ragConfig(settings);
  const kind = await vsMod.getCollectionKind(kbId);

  const docIds = await redis.smembers(`${kbId}_documents`);
  console.log(`知识库 : ${kb.name || kbId}`);
  console.log(`当前形态: ${kind}${kind === 'hybrid' ? '（已是混合索引）' : ''}`);
  console.log(`文档数 : ${docIds.length}`);
  console.log(`切分参数: ${rag.chunkSize}/${rag.chunkOverlap}  向量: ${embedding.model}(${embedding.vectorSize})`);

  if (kind === 'hybrid') {
    console.log('\n已经是混合索引，无需重建。');
    return;
  }
  if (!docIds.length) {
    console.log('\n该库没有文档，直接删掉重建一个空集合即可；这里不动。');
    return;
  }
  if (DRY) {
    console.log('\n干跑：会删除旧 collection 并按上面的参数重新入库。加 --yes 才会真的执行。');
    return;
  }
  if (!YES) {
    console.log('\n这是一个破坏性操作（删旧 collection → 重建 → 重放 uploads/ 里的原文）。');
    console.log('确认无误后加 --yes 执行。');
    return;
  }

  // 1) 先把所有文档解析成 chunk（内存里放着），避免删库后解析失败导致数据丢失
  const planned = [];
  for (const docId of docIds) {
    const doc = await redis.hgetall(`document_${docId}`);
    if (!doc || !doc.filename) continue;
    const filePath = path.join(ROOT, 'uploads', doc.filename);
    try {
      const chunks = await docMod.processDocument(filePath, doc.fileType, docId, doc.originalName, {
        chunkSize: rag.chunkSize,
        chunkOverlap: rag.chunkOverlap,
      });
      planned.push({ doc, chunks });
      console.log(`  ✓ 解析 ${doc.originalName || doc.filename}: ${chunks.length} 块`);
    } catch (e) {
      console.log(`  ✗ 解析失败 ${doc.originalName || doc.filename}: ${e.message}（跳过）`);
    }
  }
  if (!planned.length) throw new Error('没有可重建的文档');

  // 2) 删旧集合 → 新建混合集合 → 写入
  await vsMod.dropKnowledgeBaseVectors(kbId);
  const store = await vsMod.getVectorStore(kbId, embedding, rag);

  for (const { doc, chunks } of planned) {
    const docs = chunks.map(
      (c) =>
        new Document({
          pageContent: c.content,
          metadata: { ...c.metadata, documentId: doc.id, knowledgeBaseId: kbId, chunkCount: chunks.length },
        }),
    );
    await store.addDocuments(docs);
    await redis.hset(`document_${doc.id}`, 'chunkCount', String(chunks.length));
    console.log(`  ✓ 写入 ${doc.originalName || doc.filename}: ${chunks.length} 块`);
  }

  const now = await vsMod.getCollectionKind(kbId);
  console.log(`\n完成：形态 ${kind} → ${now}`);
}

main()
  .catch(async (e) => {
    console.error('\n重建失败：', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (redisConn) {
      try {
        await redisConn.quit();
      } catch {}
    }
    await rm(STAGE, { recursive: true, force: true });
  });
