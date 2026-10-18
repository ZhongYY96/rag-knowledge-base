import { cookies } from 'next/headers';
import { signToken, verifyToken, SESSION_COOKIE } from './token';
import { HttpError } from './errors';
import { redis, isMissingHash } from '@/lib/redis';

/**
 * 会话层：把 token ↔ cookie ↔ Redis 里的用户记录串起来。
 *
 * 设计取舍（面试可讲）：
 * 1) **无状态 JWT + 有状态版本号**：token 自包含，不查会话表就知道是谁；
 *    但 JWT 不能主动吊销，所以用户记录里放一个 `sessionVer`，
 *    改密码 / 强制下线时 +1，旧 token 当场失效（requireUser 里比对）。
 * 2) **httpOnly cookie 而不是 localStorage + Authorization 头**：
 *    localStorage 里的 token 任何 XSS 都能读走；httpOnly cookie 读不到。
 *    CSRF 用 SameSite=Lax 挡（本项目写操作都是同源 fetch，够用）。
 * 3) 代价是每个请求多一次 Redis hgetall（~0.2ms），
 *    换来的是「能踢人下线」——企业版必答题。
 */

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 天
const IS_PROD = process.env.NODE_ENV === 'production';

const secret = () => {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new HttpError(500, 'AUTH_SECRET 未配置');
  return s;
};

export const userKey = (id) => `user:${id}`;

/** 注册时调用；邮箱已存在则抛 409 */
export async function createUser({ id, email, name, passwordHash }) {
  const normalized = email.toLowerCase().trim();
  const exists = await redis.sismember('users:emails', normalized);
  if (exists) throw new HttpError(409, '邮箱已注册');

  const user = {
    id,
    email: normalized,
    name: name || normalized.split('@')[0],
    passwordHash,
    sessionVer: 0,
    createdAt: Date.now(),
  };

  await redis
    .multi()
    .hset(userKey(id), user)
    .sadd('users:emails', user.email) // 唯一性索引
    .hset('users:email2id', user.email, id) // 邮箱 → id 反查（登录用）
    .sadd('users', id)
    .exec();

  return user;
}

export async function getUserById(id) {
  const user = await redis.hgetall(userKey(id));
  if (isMissingHash(user)) return null;
  // Redis 里所有值都是字符串，sessionVer 要转回数字
  return { ...user, sessionVer: Number(user.sessionVer || 0) };
}

export async function getUserByEmail(email) {
  if (!email) return null;
  const id = await redis.hget('users:email2id', email.toLowerCase().trim());
  return id ? getUserById(id) : null;
}

/** 登录/注册成功后签发并下发 cookie */
export async function issueSession(user) {
  const token = signToken({
    sub: user.id,
    ver: user.sessionVer,
    ttl: SESSION_TTL,
    secret: secret(),
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // 前端 JS 读不到，XSS 偷不走
    sameSite: 'lax', // 挡跨站 POST（CSRF）
    secure: IS_PROD, // 本地 http 调试必须关掉，否则 cookie 不落
    path: '/',
    maxAge: SESSION_TTL,
  });

  return token;
}

export async function clearSession() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/**
 * 取当前用户，未登录抛 401。
 * 所有 Route Handler / Server Action 的第一行都应该调它。
 */
export async function requireUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) throw new HttpError(401, '未登录');

  const payload = verifyToken(token, secret());
  if (!payload) throw new HttpError(401, '登录已失效，请重新登录');

  const user = await getUserById(payload.sub);
  if (!user) throw new HttpError(401, '用户不存在');

  // 版本号不一致 = 这个 token 已被吊销（改密码/踢下线）
  if (user.sessionVer !== payload.ver) throw new HttpError(401, '登录已失效，请重新登录');

  return user;
}

/** 可选登录：匿名也能访问，但知道是谁 */
export async function getOptionalUser() {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}

/** 对外暴露的用户视图，绝不带 passwordHash */
export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt,
});
