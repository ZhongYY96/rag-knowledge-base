import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getBudgets, putBudget, costEnabled } from '@/lib/cost/client';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const user = await requireUser();
    const kbId = new URL(request.url).searchParams.get('knowledgeBaseId');
    if (!kbId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(kbId, user.id, 'viewer');
    if (!costEnabled()) throw new HttpError(503, '成本服务未启用');
    return NextResponse.json(await getBudgets(kbId));
  } catch (error) {
    return toResponse(error, '读取预算失败');
  }
}

export async function PUT(request) {
  try {
    const user = await requireUser();
    const body = await request.json().catch(() => ({}));
    if (!body.knowledgeBaseId) throw new HttpError(400, '缺少 knowledgeBaseId');
    // 预算会影响这个库的花费，要求 editor
    await requireKb(body.knowledgeBaseId, user.id, 'editor');
    if (!costEnabled()) throw new HttpError(503, '成本服务未启用');

    const saved = await putBudget({
      tenant_id: body.knowledgeBaseId,
      period: 'daily',
      limit_micro_usd: Number(body.limit_micro_usd) || 0,
      action: String(body.action || 'WARN').toUpperCase(),
      warn_at_pct: Number(body.warn_at_pct) || 80,
    });
    return NextResponse.json(saved);
  } catch (error) {
    return toResponse(error, '保存预算失败');
  }
}
