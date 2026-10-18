import { z } from 'zod';
import { redis } from '@/lib/redis';
import { verifyPassword } from '@/lib/auth/password';
import { getUserByEmail, issueSession } from '@/lib/auth/session';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** 失败计数：同一邮箱 15 分钟内连续失败 5 次，先锁 15 分钟 */
async function guardBruteForce(email, ip) {
  const key = `login:fail:${email}:${ip}`;
  const fails = Number((await redis.get(key)) || 0);
  if (fails >= 5) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
  return key;
}

export async function POST(req) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
    const body = await req.json();
    const { email, password } = schema.parse(body);

    const failKey = await guardBruteForce(email.toLowerCase(), ip);

    const user = await getUserByEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;

    if (!ok) {
      // 不区分「用户不存在」和「密码错误」——否则就是个账号枚举接口
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, 15 * 60);
      // 登录失败要记：这是暴力破解/账号异常的第一现场
      await audit({
        action: 'auth.login_failed',
        result: 'denied',
        actorEmail: email,
        ip: clientIp(req),
        meta: { failures: n },
      });
      throw new HttpError(401, '邮箱或密码错误');
    }

    await redis.del(failKey);
    await issueSession(user);

    await audit({
      action: 'auth.login',
      actorId: user.id,
      actorEmail: user.email,
      ip: clientIp(req),
    });

    return Response.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: '参数不合法' }, { status: 400 });
    }
    return toResponse(error, '登录失败');
  }
}
