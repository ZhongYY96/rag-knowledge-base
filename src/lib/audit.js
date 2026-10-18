import { redis } from '@/lib/redis';

/**
 * 审计日志。
 *
 * 存哪：Redis 单条链表 `audit:log`（LPUSH + LTRIM 保留最近 5000 条）。
 *   为什么不用文件/数据库：这个项目只有 Redis，审计是"写得快、读得少"的场景，
 *   链表天然按时间倒序，一条 LPUSH 就够；5000 条上限是为了防 demo 里写爆内存。
 *
 * 看哪：/audit 页面（只看与自己相关的），或 GET /api/audit（带过滤）。
 *
 * 原则：**只记事实，不记敏感内容**。密码、API Key、token 一律替换成 ***。
 */

const KEY = 'audit:log';
const MAX = 5000;

const SECRET_RE = /(key|token|secret|password|authorization|cookie)/i;

/** 递归抹掉敏感字段 */
export function scrub(value) {
  if (!value || typeof value !== 'object') return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_RE.test(k)) out[k] = '***';
    else out[k] = scrub(v);
  }
  return out;
}

export const clientIp = (req) =>
  req?.headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  req?.headers?.get('x-real-ip') ||
  '127.0.0.1';

/**
 * 写一条审计。**永不抛错**——审计失败不能影响主流程。
 * @param {{action:string, result?:'ok'|'denied'|'error', actorId?:string, actorEmail?:string,
 *          kbId?:string, target?:string, ip?:string, meta?:object}} event
 */
export async function audit(event) {
  try {
    const entry = scrub({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      result: 'ok',
      actorId: null,
      actorEmail: null,
      kbId: null,
      target: null,
      ip: null,
      meta: null,
      ...event,
    });
    await redis.lpush(KEY, JSON.stringify(entry));
    await redis.ltrim(KEY, 0, MAX - 1);
  } catch (error) {
    console.warn('[audit] 写入失败:', error.message);
  }
}

/**
 * 读审计。默认按时间倒序。
 * 可见性：自己做的事，或发生在自己有权限的知识库里的事。
 */
export async function listAudit({
  limit = 100,
  action = null,
  kbId = null,
  selfId = null,
  allowedKbIds = null,
} = {}) {
  const raw = await redis.lrange(KEY, 0, MAX - 1);
  const out = [];

  for (const line of raw) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (action && e.action !== action) continue;
    if (kbId && e.kbId !== kbId) continue;

    const visible =
      !selfId ||
      e.actorId === selfId ||
      (e.kbId && Array.isArray(allowedKbIds) && allowedKbIds.includes(e.kbId));
    if (!visible) continue;

    out.push(e);
    if (out.length >= limit) break;
  }

  return out;
}

/** 页面/接口用的中文标签 */
export const AUDIT_LABELS = {
  'auth.register': '注册',
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.logout_all': '全部设备退出',
  'kb.create': '新建知识库',
  'kb.delete': '删除知识库',
  'kb.access_denied': '越权访问被拒',
  'doc.upload': '上传文档',
  'doc.delete': '删除文档',
  'settings.update': '修改设置',
  'eval.run': '运行评测',
  'eval.golden_import': '导入测试集',
  'eval.golden_clear': '清空测试集',
};

export const auditLabel = (action) => AUDIT_LABELS[action] || action;
