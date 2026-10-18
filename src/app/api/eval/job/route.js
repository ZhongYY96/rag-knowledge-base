import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getJob } from '@/lib/rag/evalJob';
import { latestReport } from '@/lib/rag/eval';

export const dynamic = 'force-dynamic';

/** GET /api/eval/job?knowledgeBaseId=xxx —— 页面轮询进度用 */
export async function GET(request) {
  try {
    const user = await requireUser();
    const knowledgeBaseId = new URL(request.url).searchParams.get('knowledgeBaseId');
    if (!knowledgeBaseId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(knowledgeBaseId, user.id, 'viewer');

    const job = await getJob(knowledgeBaseId);

    // 任务刚完成时，把最新报告一起带回去，省一次刷新
    let report = null;
    if (job?.status === 'done') report = await latestReport(knowledgeBaseId);

    return NextResponse.json({ job, report });
  } catch (error) {
    return toResponse(error, '读取任务状态失败');
  }
}
