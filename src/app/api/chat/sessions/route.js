import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { newSession, listSessions } from '@/lib/chatSessions';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** GET /api/chat/sessions?knowledgeBaseId=xxx */
export async function GET(request) {
  try {
    const user = await requireUser();
    const kbId = new URL(request.url).searchParams.get('knowledgeBaseId');
    if (!kbId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(kbId, user.id, 'viewer');

    return NextResponse.json({ items: await listSessions(kbId) });
  } catch (error) {
    return toResponse(error, '读取会话列表失败');
  }
}

/** POST /api/chat/sessions { knowledgeBaseId, title? } */
export async function POST(request) {
  try {
    const user = await requireUser();
    const body = await request.json().catch(() => ({}));
    const kbId = body.knowledgeBaseId;
    if (!kbId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(kbId, user.id, 'viewer');

    const session = await newSession({ knowledgeBaseId: kbId, ownerId: user.id, title: body.title });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return toResponse(error, '新建会话失败');
  }
}
