import { requireUser, publicUser } from '@/lib/auth/session';
import { toResponse } from '@/lib/auth/errors';

export const dynamic = 'force-dynamic';

/** 给前端做「已登录吗」的探针，返回最小字段集（publicUser 保证不含 passwordHash） */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ user: publicUser(user) });
  } catch (error) {
    return toResponse(error, '获取用户失败');
  }
}
