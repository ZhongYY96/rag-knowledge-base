import { z } from 'zod';
import { redis } from '@/lib/redis';
import { hashPassword } from '@/lib/auth/password';
import { createUser, issueSession } from '@/lib/auth/session';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { audit, clientIp } from '@/lib/audit';
import { generateId } from '@/lib/database';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().email('邮箱格式不对'),
  // 至少 8 位且不能是纯数字：挡住最烂的一批弱口令
  password: z
    .string()
    .min(8, '密码至少 8 位')
    .refine((v) => !/^\d+$/.test(v), '密码不能是纯数字'),
  name: z.string().trim().max(40).optional(),
});

/** 简单的注册频控：同一 IP 每小时 10 个账号 */
async function checkRegisterLimit(ip) {
  const key = `register:${ip}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 3600);
  return n <= 10;
}

export async function POST(req) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
    if (!(await checkRegisterLimit(ip))) throw new HttpError(429, '注册过于频繁，请稍后再试');

    const body = await req.json();
    const { email, password, name } = schema.parse(body);

    const passwordHash = await hashPassword(password);
    const user = await createUser({ id: generateId('user'), email, name, passwordHash });

    await issueSession(user);

    await audit({
      action: 'auth.register',
      actorId: user.id,
      actorEmail: user.email,
      ip: clientIp(req),
    });

    // 绝不返回 passwordHash —— 这是最容易漏的一行
    return Response.json({ user: { id: user.id, email: user.email, name: user.name } }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: error.errors[0]?.message || '参数不合法' }, { status: 400 });
    }
    return toResponse(error, '注册失败');
  }
}
