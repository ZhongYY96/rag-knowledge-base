import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

/**
 * 最小 JWT（HS256），零依赖，只用 node:crypto。
 *
 * 为什么手写而不用 jose：这个项目现在连 package.json 都没有，
 * 加依赖会牵扯锁文件和版本对齐。HS256 的签名/校验只有 40 行，
 * 而且**该防的坑都防了**（见 verifyToken 的四道检查），
 * 拿到生产环境再换 jose / next-auth 也不影响调用方。
 *
 * ⚠️ 只在 Node runtime 用（Route Handler / Server Action / Server Component）。
 *    不要放进 middleware —— Edge runtime 没有 node:crypto，
 *    而 middleware 本来就不该是安全边界（见 docs/auth-and-private-kb.md）。
 *
 * 环境变量：AUTH_SECRET（≥32 字符）。生产必须换掉，且只放服务端。
 *   openssl rand -base64 48
 */

const ALG = 'HS256';
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function secretKey(secret) {
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET 未配置或长度不足 32 字符');
  }
  return Buffer.from(secret, 'utf8');
}

function sign(data, secret) {
  return b64u(createHmac('sha256', secretKey(secret)).update(data).digest());
}

/**
 * @param {{sub: string, ver?: number, ttl?: number, secret: string}} opts
 * @returns {string} token
 */
export function signToken({ sub, ver = 0, ttl = 60 * 60 * 24 * 7, secret }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub, // 用户 id
    ver, // 会话版本号：改密码/踢下线时 +1，旧 token 立即失效
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const head = enc({ alg: ALG, typ: 'JWT' });
  const body = enc(payload);
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

/**
 * 校验失败一律返回 null，不抛异常、不区分原因（避免给攻击者反馈）。
 * 四道检查：结构 → 算法白名单 → 签名（定长比较）→ 过期。
 */
export function verifyToken(token, secret) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headB64, bodyB64, sigB64] = parts;

    // ① 算法白名单：必须显式拒绝 alg=none / RS256 混合攻击，
    //    这是「拿公钥当私钥」类漏洞的入口。
    const header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8'));
    if (header?.alg !== ALG) return null;

    // ② 定长比较签名（timingSafeEqual 要求等长，长度不同直接判失败）
    const expected = sign(`${headB64}.${bodyB64}`, secret);
    const a = Buffer.from(sigB64);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    // ③ 过期
    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload?.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload?.sub !== 'string' || !payload.sub) return null;

    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'kb_session';
