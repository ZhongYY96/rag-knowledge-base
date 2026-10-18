import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getSessionBundle, saveJob } from '@/lib/chatSessions';
import { clearStream } from '@/lib/chatStream';

export const dynamic = 'force-dynamic';

/**
 * POST /api/chat/sessions/[id]/cancel
 *
 * 手动结束一个卡住的任务。
 * 用途：进程重启/请求丢失会让 job 永远停在 running，用户既看不到结果也发不了新消息。
 */
export async function POST(request, { params }) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const bundle = await getSessionBundle(id);
    if (!bundle) throw new HttpError(404, '会话不存在');
    await requireKb(bundle.session.knowledgeBaseId, user.id, 'viewer');

    await clearStream(id);
    await saveJob(id, {
      status: 'failed',
      startedAt: bundle.job?.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      error: '已手动取消',
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return toResponse(error, '取消失败');
  }
}
