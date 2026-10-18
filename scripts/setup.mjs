#!/usr/bin/env node
/**
 * 傻瓜式部署自检 + 引导。
 *
 *   npm run setup    # 检查环境、拉起依赖、生成 .env.local
 *   npm run up       # setup 之后直接启动 dev
 *
 * 原则：**能自动做的自动做，不能自动做的把错误和修法说清楚**。
 */
import { existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const ROOT = process.cwd();
const OK = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const BAD = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const WARN = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const INFO = (m) => console.log(`    ${m}`);

const fatal = [];

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) OK(`Node ${process.versions.node}`);
  else {
    BAD(`Node ${process.versions.node} 太旧，需要 >= 20（建议 20 或 22 LTS）`);
    fatal.push('node');
  }
}

function bootstrapEnv() {
  const target = path.join(ROOT, '.env.local');
  const example = path.join(ROOT, '.env.example');
  if (existsSync(target)) OK('.env.local 已存在');
  else if (!existsSync(example)) WARN('没有 .env.example，跳过（将使用代码内默认值）');
  else {
    copyFileSync(example, target);
    OK('已从 .env.example 生成 .env.local（按需修改，不要提交）');
  }
}

function checkDeps() {
  if (existsSync(path.join(ROOT, 'node_modules', 'next'))) OK('依赖已安装');
  else {
    BAD('缺少 node_modules');
    INFO('执行：npm ci    （.npmrc 已设置 legacy-peer-deps，无需额外参数）');
    fatal.push('deps');
  }
}

function tcp(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function parseUrl(raw, fallback) {
  try {
    const u = new URL(raw || fallback);
    return { host: u.hostname, port: Number(u.port) || (u.protocol.startsWith('https') ? 443 : 80) };
  } catch {
    return parseUrl(fallback, fallback);
  }
}

async function checkServices() {
  const redis = parseUrl(process.env.REDIS_URL, 'redis://127.0.0.1:6379');
  const qdrant = parseUrl(process.env.QDRANT_URL, 'http://127.0.0.1:6333');

  const redisUp = await tcp(redis.host, redis.port);
  const qdrantUp = await tcp(qdrant.host, qdrant.port);

  if (redisUp) OK(`Redis 可连接 ${redis.host}:${redis.port}`);
  else WARN(`Redis 连不上 ${redis.host}:${redis.port}`);

  if (qdrantUp) OK(`Qdrant 可连接 ${qdrant.host}:${qdrant.port}`);
  else WARN(`Qdrant 连不上 ${qdrant.host}:${qdrant.port}`);

  if (redisUp && qdrantUp) return;

  const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (docker.status !== 0) {
    BAD('本机没有 Docker，且依赖未启动');
    INFO('二选一：装 Docker Desktop / 或自己搭 Redis+Qdrant 后在 .env.local 填地址');
    fatal.push('services');
    return;
  }

  console.log('\n  正在用 docker compose 拉起 redis 和 qdrant…');
  // 新版是 `docker compose`，老版本是 `docker-compose`，都试一下
  let up = spawnSync('docker', ['compose', 'up', '-d', 'redis', 'qdrant'], { stdio: 'inherit' });
  if (up.status !== 0) {
    up = spawnSync('docker-compose', ['up', '-d', 'redis', 'qdrant'], { stdio: 'inherit' });
  }
  if (up.status !== 0) {
    BAD('docker compose 启动失败');
    INFO('常见原因：端口被占用（6379/6333）、Docker 未启动');
    fatal.push('services');
    return;
  }

  console.log('  等待服务就绪…');
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const [a, b] = await Promise.all([tcp(redis.host, redis.port), tcp(qdrant.host, qdrant.port)]);
    if (a && b) {
      OK('Redis + Qdrant 已就绪');
      return;
    }
  }
  BAD('等了 60 秒依赖仍未就绪');
  INFO('执行 docker compose logs redis qdrant 看原因');
  fatal.push('services');
}

async function checkPort() {
  const busy = await tcp('127.0.0.1', 3000, 600);
  if (busy) {
    WARN('端口 3000 已被占用（可能已有一个实例在跑）');
    INFO('先停掉旧进程，或启动时换端口：npx next dev -p 3001');
  } else OK('端口 3000 空闲');
}

async function checkModels() {
  const targets = [
    ['对话模型', process.env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1'],
    ['向量模型', process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:8001/v1'],
  ];

  for (const [name, base] of targets) {
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${base.replace(/\/$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) OK(`${name}可访问 ${base}`);
    else {
      WARN(`${name}无响应 ${base}（不影响启动，但问答会失败）`);
      INFO('本地起模型，或在 /settings 里改成你的 OpenAI 兼容地址');
    }
  }
}

function summary() {
  console.log('\n────────────────────────────────────────');
  if (fatal.length) {
    console.log('\x1b[31m环境还没准备好，先解决上面的 ✗ 项。\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32m一切就绪。下一步：\x1b[0m');
  console.log('  npm run dev      启动开发服务 → http://localhost:3000');
  console.log('  首次使用：打开 /register 注册 → 建知识库 → 上传文档 → 开始提问');
}

console.log('\n=== RAG 知识库 · 部署自检 ===\n');
checkNode();
bootstrapEnv();
checkDeps();
await checkServices();
await checkPort();
await checkModels();
summary();
