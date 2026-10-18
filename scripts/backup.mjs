#!/usr/bin/env node
/**
 * 备份 Redis（用户/知识库/会话/审计）+ Qdrant（向量）+ uploads（原始文件）。
 *
 *   npm run backup            # 生成 backups/<时间戳>/
 *
 * 为什么需要：注册数据、知识库、对话记录**全在 docker volume 里**。
 *   docker compose down        → 数据还在（volume 保留）
 *   docker compose down -v     → 数据全没（volume 删除）
 *   换机器/重新 clone          → 数据全没
 * 所以定期备份，或者至少在大改之前备份。
 */
import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.join(ROOT, 'backups', stamp);
mkdirSync(dir, { recursive: true });

const QDRANT = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);

console.log(`\n=== 备份到 backups/${stamp}\n`);

// 1) Redis：先 SAVE 落盘，再把 dump.rdb 拷出来
const save = sh('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'SAVE']);
if (save.status === 0) {
  const cp = sh('docker', ['compose', 'cp', 'redis:/data/dump.rdb', path.join(dir, 'redis-dump.rdb')]);
  if (cp.status === 0) ok('Redis dump.rdb');
  else warn(`Redis 拷贝失败：${cp.stderr?.trim()}`);
} else {
  warn('Redis SAVE 失败（容器没起？）：docker compose up -d redis');
}

// 2) Qdrant：逐集合打快照并下载
try {
  const list = await (await fetch(`${QDRANT}/collections`)).json();
  const names = (list.result?.collections ?? []).map((c) => c.name);
  if (!names.length) warn('Qdrant 里没有集合（还没上传过文档）');
  for (const name of names) {
    const created = await (await fetch(`${QDRANT}/collections/${name}/snapshots`, { method: 'POST' })).json();
    const file = created.result?.name;
    if (!file) {
      warn(`集合 ${name} 快照创建失败`);
      continue;
    }
    const res = await fetch(`${QDRANT}/collections/${name}/snapshots/${file}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const target = path.join(dir, `qdrant-${name}.snapshot`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(target, buf);
    ok(`Qdrant ${name}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
  }
} catch (e) {
  warn(`Qdrant 备份失败：${e.message}`);
}

// 3) uploads：原始文档（重建索引需要）
const uploads = path.join(ROOT, 'uploads');
if (existsSync(uploads)) {
  const files = readdirSync(uploads).filter((f) => statSync(path.join(uploads, f)).isFile());
  const dest = path.join(dir, 'uploads');
  mkdirSync(dest, { recursive: true });
  for (const f of files) copyFileSync(path.join(uploads, f), path.join(dest, f));
  ok(`uploads（${files.length} 个文件）`);
} else {
  warn('没有 uploads 目录');
}

console.log(`\n备份完成：${dir}`);
console.log('恢复方法见 README「备份与恢复」。\n');
