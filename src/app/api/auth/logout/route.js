import { redis } from '@/lib/redis';
import { clearSession, requireUser, userKey } from '@/lib/auth/session';
import { toResponse } from '@/lib/auth/errors';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * 退出登录。
 * - 默认：只清 cookie（其他设备不受影响）
 * - ?all=1：sessionVer +1，**所有设备**的 token 立即失效（改密码后也该这么干）
 */
export async function POST(req) {
  try {
    const url = new URL(req.url);
    let user = null;
    if (url.searchParams.get('all') === '1') {
      user = await requireUser();
      await redis.hincrby(userKey(user.id), 'sessionVer', 1);
    }
    await clearSession();

    await audit({
      action: url.searchParams.get('all') === '1' ? 'auth.logout_all' : 'auth.logout',
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      ip: clientIp(req),
    });

    return Response.json({ success: true });
  } catch (error) {
    return toResponse(error, '退出失败');
  }
}
