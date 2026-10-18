import { NextResponse, after } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getSessionBundle, appendMessage, saveJob, renameIfGeneric } from '@/lib/chatSessions';
import { clearStream } from '@/lib/chatStream';
import { runSessionTurn } from '@/lib/rag/chatTurn';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/**
 * POST /api/chat/sessions/[id]/messages { text }
 *
 * 关键：**先落库用户消息 → 起后台任务 → 立刻 202 返回**。
 * 生成在 after() 里跑，浏览器切页面/刷新都不影响它跑完并落库。
 */
export async function POST(request, { params }) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const bundle = await getSessionBundle(id);
    if (!bundle) throw new HttpError(404, '会话不存在');
    const kbId = bundle.session.knowledgeBaseId;
    await requireKb(kbId, user.id, 'viewer');

    if (bundle.job?.status === 'running') {
      throw new HttpError(409, '这个会话正在生成中，等它完成再提问');
    }

    const body = await request.json().catch(() => ({}));
    const text = String(body.text ?? '').trim();
    if (!text) throw new HttpError(400, '问题不能为空');
    if (text.length > 2000) throw new HttpError(400, '问题过长');

    /*
     * ⚠️ 必须先清空上一轮的增量流。
     * 否则旧流尾部的 done 标记会让新订阅"秒关"——SSE 一回放到旧 done 就收尾了，
     * 界面就卡在"正在检索并生成"，正文其实在后面才生成完。
     */
    await clearStream(id);

    const userMessage = await appendMessage(id, { role: 'user', content: text, sources: [] });
    await renameIfGeneric(id, text);

    const job = { status: 'running', question: text.slice(0, 60), startedAt: Date.now() };
    await saveJob(id, job);

    // 后台跑，不阻塞响应，也不受浏览器生命周期影响
    after(async () => {
      await runSessionTurn({ sessionId: id, kbId, userId: user.id });
    });

    return NextResponse.json({ userMessage, job }, { status: 202 });
  } catch (error) {
    return toResponse(error, '发送消息失败');
  }
}
