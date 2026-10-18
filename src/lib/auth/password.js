import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * 密码哈希：scrypt（Node 内置，零依赖）。
 *
 * 为什么不用 md5/sha256：那类快哈希在 GPU 上每秒能试几十亿次，
 * 一个 8 位密码几小时跑完。scrypt 是**内存硬**的——N 越大越吃内存，
 * 攻击者无法靠并行显卡摊薄成本。
 *
 * 为什么不用 bcrypt：npm 的 bcrypt 要编译原生模块，换机器/换 Node 版本常炸；
 * bcryptjs 是纯 JS 但要额外依赖。scrypt 是 Node 标准库自带的，效果同级。
 *
 * 参数取 OWASP 推荐的低档位（N=16384, r=8, p=1，约 16MB 内存/次），
 * 单次约 50–100ms：够挡住离线爆破，又不至于让登录接口被拖垮。
 *
 * 存储格式：scrypt$N$r$p$salt$hash（都是 base64url），
 * 把参数和盐一起存，以后调参也不会让老密码失效。
 */
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('密码至少 8 位');
  }
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = await scryptAsync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });

    // 必须用 timingSafeEqual：普通的 === 会在第一个不同字节就返回，
    // 攻击者能按耗时逐字节猜出哈希（时序侧信道）。
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
