import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { toResponse } from '@/lib/auth/errors';
import { listAudit } from '@/lib/audit';
import { listKnowledgeBasesForUser } from '@/lib/database';

export const dynamic = 'force-dynamic';

/** GET /api/audit?limit=&action=&kbId= —— 只返回与你相关的记录 */
export async function GET(request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const kbs = await listKnowledgeBasesForUser(user.id);

    const items = await listAudit({
      limit: Math.min(Number(url.searchParams.get('limit')) || 100, 500),
      action: url.searchParams.get('action') || null,
      kbId: url.searchParams.get('kbId') || null,
      selfId: user.id,
      allowedKbIds: kbs.map((k) => k.id),
    });

    return NextResponse.json({ items, count: items.length });
  } catch (error) {
    return toResponse(error, '读取审计日志失败');
  }
}
