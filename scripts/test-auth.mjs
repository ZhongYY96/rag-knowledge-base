#!/usr/bin/env node
/**
 * 零依赖自测：`node scripts/test-auth.mjs` 直接跑。
 * 不需要装包、不需要起 Redis、不需要起 Next。
 *
 *   password  6 条：哈希/校验/加盐/脏数据/弱口令
 *   token     9 条：签发/篡改/alg=none/过期/错误密钥
 *   kbAccess 24 条：越权 404、列表隔离、共享加人、owner 自锁保护、删库清理索引
 *
 * 原理：把 database.js 的 './redis' 换成内存桩，把 kbAccess.js 的
 * '@/lib/database' 别名换成本地文件，然后按真实模块图跑。
 * 测的是**真代码**，不是复制粘贴的副本。
 *
 * 面试用法：这不是"我写了单测"，是"我用 24 条越权用例卡住了权限回归"。
 */
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(here, '..', 'src', 'lib', 'auth');
const libDir = path.join(here, '..', 'src', 'lib');

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name);
  }
};
const rejectsWith = async (fn, status) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return e.status === status;
  }
};

// ─────────────────────────── 内存版 Redis 桩 ───────────────────────────
const hashes = new Map();
const sets = new Map();
const lists = new Map();
const H = (k) => (hashes.has(k) ? hashes.get(k) : hashes.set(k, new Map()).get(k));
const S = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));

const redis = {
  async hset(k, a, b) {
    const m = H(k);
    if (a && typeof a === 'object') for (const [f, v] of Object.entries(a)) m.set(f, String(v));
    else m.set(String(a), String(b));
    return 1;
  },
  async hgetall(k) {
    const m = hashes.get(k);
    return m && m.size ? Object.fromEntries(m) : {};
  },
  async hget(k, f) {
    return hashes.get(k)?.get(f) ?? null;
  },
  async hkeys(k) {
    return [...(hashes.get(k)?.keys() ?? [])];
  },
  async hincrby(k, f, n) {
    const m = H(k);
    const v = Number(m.get(f) || 0) + Number(n);
    m.set(f, String(v));
    return v;
  },
  async exists(k) {
    return hashes.has(k) || sets.has(k) || lists.has(k) ? 1 : 0;
  },
  async sadd(k, v) {
    S(k).add(v);
    return 1;
  },
  async srem(k, v) {
    S(k).delete(v);
    return 1;
  },
  async smembers(k) {
    return [...(sets.get(k) ?? [])];
  },
  async scard(k) {
    return sets.get(k)?.size ?? 0;
  },
  async llen(k) {
    return lists.get(k)?.length ?? 0;
  },
  async lrange(k) {
    return [...(lists.get(k) ?? [])];
  },
  async rpush(k, v) {
    (lists.get(k) ?? lists.set(k, []).get(k)).push(v);
    return 1;
  },
  async del(k) {
    hashes.delete(k);
    sets.delete(k);
    lists.delete(k);
    return 1;
  },
  async get() {
    return null;
  },
  async incr() {
    return 1;
  },
  async expire() {
    return 1;
  },
  multi() {
    const ops = [];
    const chain = {
      hset: (...a) => (ops.push(() => redis.hset(...a)), chain),
      sadd: (...a) => (ops.push(() => redis.sadd(...a)), chain),
      srem: (...a) => (ops.push(() => redis.srem(...a)), chain),
      hdel: (...a) => (ops.push(async () => (hashes.get(a[0])?.delete(a[1]), 1)), chain),
      del: (...a) => (ops.push(() => redis.del(...a)), chain),
      exec: async () => Promise.all(ops.map((f) => f())),
    };
    return chain;
  },
};

// ─────────── 复刻真实模块图：别名 → 本地桩，逐个改写 import ───────────
async function loadModules() {
  const dir = await mkdtemp(path.join(tmpdir(), 'auth-test-'));

  await writeFile(
    path.join(dir, 'redis.mock.mjs'),
    `export const redis = globalThis.__TEST_REDIS__;
export const isMissingHash = (x) => !x || typeof x !== 'object' || Object.keys(x).length === 0;`,
  );

  // errors.js 没有 import，原样复制即可
  await writeFile(path.join(dir, 'errors.mjs'), await readFile(path.join(authDir, 'errors.js'), 'utf8'));

  // database.js 只 import './redis'
  const dbSrc = await readFile(path.join(libDir, 'database.js'), 'utf8');
  const dbPatched = dbSrc.replace("from './redis'", "from './redis.mock.mjs'");
  if (dbPatched === dbSrc) throw new Error("database.js 的 './redis' import 结构变了");
  await writeFile(path.join(dir, 'database.mjs'), dbPatched);

  // kbAccess.js import '@/lib/database' 和 './errors'
  const kbSrc = await readFile(path.join(authDir, 'kbAccess.js'), 'utf8');
  const kbPatched = kbSrc
    .replace("from '@/lib/database'", "from './database.mjs'")
    .replace("from './errors'", "from './errors.mjs'");
  if (kbPatched === kbSrc) throw new Error('kbAccess.js 的 import 结构变了');
  await writeFile(path.join(dir, 'kbAccess.mjs'), kbPatched);

  globalThis.__TEST_REDIS__ = redis;

  const database = await import(`file://${path.join(dir, 'database.mjs')}`);
  const kbAccess = await import(`file://${path.join(dir, 'kbAccess.mjs')}`);
  return { database, kbAccess };
}

// ─────────────────────────────── 跑用例 ───────────────────────────────
const { hashPassword, verifyPassword } = await import(`file://${path.join(authDir, 'password.js')}`);
const { signToken, verifyToken } = await import(`file://${path.join(authDir, 'token.js')}`);

console.log('password:');
const h = await hashPassword('correct horse battery');
ok('hash 格式正确', /^scrypt\$16384\$8\$1\$/.test(h));
ok('正确密码通过', await verifyPassword('correct horse battery', h));
ok('错误密码拒绝', (await verifyPassword('wrong password', h)) === false);
ok('两次哈希不同（有加盐）', (await hashPassword('correct horse battery')) !== h);
ok('脏数据不崩', (await verifyPassword('x', 'garbage')) === false);
ok('短密码拒绝', await hashPassword('123').then(() => false, () => true));

console.log('token:');
const SECRET = 'a'.repeat(48);
const t = signToken({ sub: 'user_1', ver: 3, secret: SECRET });
const p = verifyToken(t, SECRET);
ok('正常校验通过', p && p.sub === 'user_1' && p.ver === 3);
ok('jti 存在', typeof p.jti === 'string' && p.jti.length > 10);
ok('错误密钥拒绝', verifyToken(t, 'b'.repeat(48)) === null);
const [hd, bd, sg] = t.split('.');
const evil = Buffer.from(JSON.stringify({ ...p, sub: 'admin' })).toString('base64url');
ok('篡改 payload 被拒', verifyToken(`${hd}.${evil}.${sg}`, SECRET) === null);
const noneHead = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
ok('alg=none 被拒', verifyToken(`${noneHead}.${bd}.`, SECRET) === null);
ok('过期 token 被拒', verifyToken(signToken({ sub: 'u', ttl: -10, secret: SECRET }), SECRET) === null);
ok('乱串被拒', verifyToken('a.b.c', SECRET) === null);
ok('空值被拒', verifyToken(null, SECRET) === null);
ok('短 secret 抛错', await (async () => {
  try {
    signToken({ sub: 'u', secret: 'short' });
    return false;
  } catch {
    return true;
  }
})());

console.log('kbAccess · 建库与归属:');
const { database, kbAccess } = await loadModules();
const {
  createKnowledgeBase,
  listKnowledgeBasesForUser,
  getKbRole,
  deleteKnowledgeBase,
  addDocument,
} = database;
const { requireKb, addMember, removeMember } = kbAccess;

const A = 'user_A';
const B = 'user_B';
await redis.hset(`user:${A}`, { id: A, email: 'a@x.com' });
await redis.hset(`user:${B}`, { id: B, email: 'b@x.com' });

const kbA = await createKnowledgeBase({ name: 'A 的私有库', ownerId: A });
ok('新建库默认 private', kbA.visibility === 'private');
ok('owner 落在 kb 字段上', kbA.ownerId === A);
ok('owner 的 role 是 owner', (await getKbRole(kbA.id, A)) === 'owner');
ok('没有 ownerId 直接拒绝建库', await createKnowledgeBase({ name: 'x' }).then(() => false, () => true));

console.log('kbAccess · 越权拦截:');
ok('B 读 A 的库 → 404', await rejectsWith(() => requireKb(kbA.id, B), 404));
ok('B 改 A 的库 → 404', await rejectsWith(() => requireKb(kbA.id, B, 'owner'), 404));
ok('B 写 A 的库 → 404', await rejectsWith(() => requireKb(kbA.id, B, 'editor'), 404));
ok('不存在的库 → 404', await rejectsWith(() => requireKb('kb_nope', A), 404));
ok('空 kbId → 404', await rejectsWith(() => requireKb('', A), 404));
ok('未登录（无 userId）→ 401', await rejectsWith(() => requireKb(kbA.id, null), 401));

console.log('kbAccess · 列表隔离:');
ok('B 的库列表为空', (await listKnowledgeBasesForUser(B)).length === 0);
ok('A 的库列表只有自己那 1 个', (await listKnowledgeBasesForUser(A)).length === 1);
ok('列表项带 role=owner', (await listKnowledgeBasesForUser(A))[0].role === 'owner');
ok('列表项带文档数', (await listKnowledgeBasesForUser(A))[0]._count.documents === 0);

console.log('kbAccess · 共享:');
await addMember(A, kbA.id, B, 'viewer');
ok('加成员后 B 能看到', (await listKnowledgeBasesForUser(B)).length === 1);
ok('B 的角色是 viewer', (await getKbRole(kbA.id, B)) === 'viewer');
ok('viewer 可以读', !!(await requireKb(kbA.id, B, 'viewer')));
ok('viewer 不能写 → 403', await rejectsWith(() => requireKb(kbA.id, B, 'editor'), 403));
ok('viewer 不能改成员 → 403', await rejectsWith(() => addMember(B, kbA.id, A, 'viewer'), 403));
ok('非 owner 不能移除他人 → 403', await rejectsWith(() => removeMember(B, kbA.id, A), 403));
ok('owner 不能移除自己 → 400', await rejectsWith(() => removeMember(A, kbA.id, A), 400));

await removeMember(A, kbA.id, B);
ok('移除后 B 列表清空', (await listKnowledgeBasesForUser(B)).length === 0);
ok('移除后 B 读不到 → 404', await rejectsWith(() => requireKb(kbA.id, B), 404));
ok('owner 不受影响', !!(await requireKb(kbA.id, A, 'owner')));

console.log('kbAccess · 删库清理:');
await addMember(A, kbA.id, B, 'viewer');
await addDocument({ filename: 'f.txt', originalName: 'f.txt', fileType: 'text/plain', fileSize: 1, knowledgeBaseId: kbA.id });
ok('删库前有 1 个文档', (await listKnowledgeBasesForUser(A))[0]._count.documents === 1);
await deleteKnowledgeBase(kbA.id);
ok('删库后 A 的列表清空', (await listKnowledgeBasesForUser(A)).length === 0);
ok('删库后 B 的列表清空（反查索引已清）', (await listKnowledgeBasesForUser(B)).length === 0);
ok('删库后成员表已删', (await redis.hgetall(`knowledgebase_${kbA.id}:members`)) && Object.keys(await redis.hgetall(`knowledgebase_${kbA.id}:members`)).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
