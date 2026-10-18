import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getSessionBundle, removeSession } from '@/lib/chatSessions';

export const dynamic = 'force-dynamic';

/** GET /api/chat/sessions/[id] —— 会话 + 消息 + 任务状态（页面轮询用） */
export async function GET(request, { params }) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const bundle = await getSessionBundle(id);
    if (!bundle) throw new HttpError(404, '会话不存在');
    // 会话属于知识库，权限跟着库走
    await requireKb(bundle.session.knowledgeBaseId, user.id, 'viewer');

    return NextResponse.json(bundle);
  } catch (error) {
    return toResponse(error, '读取会话失败');
  }
}

export async function DELETE(request, { params }) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const bundle = await getSessionBundle(id);
    if (!bundle) throw new HttpError(404, '会话不存在');
    await requireKb(bundle.session.knowledgeBaseId, user.id, 'editor');

    await removeSession(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return toResponse(error, '删除会话失败');
  }
}
