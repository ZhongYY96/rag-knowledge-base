import { NextResponse } from 'next/server';
import { createKnowledgeBase, listKnowledgeBasesForUser } from '@/lib/database';
import { requireUser } from '@/lib/auth/session';
import { toResponse } from '@/lib/auth/errors';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/knowledgebase —— 只返回「当前用户可见」的库（返回数组，保持旧前端契约）
 * POST /api/knowledgebase —— 建私有库，owner = 当前用户
 *
 * ownerId 一律从 cookie 解析，**不读请求体里的 ownerId**。
 */
export async function GET() {
  try {
    const user = await requireUser();
    const knowledgeBases = await listKnowledgeBasesForUser(user.id);
    return NextResponse.json(knowledgeBases);
  } catch (error) {
    return toResponse(error, 'Failed to fetch knowledge bases');
  }
}

export async function POST(request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const { name, description } = body;

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: '名称为必填项' }, { status: 400 });
    }

    const knowledgeBase = await createKnowledgeBase({
      name: String(name).trim().slice(0, 60),
      description: (description || '').slice(0, 300),
      ownerId: user.id,
    });

    await audit({
      action: 'kb.create',
      actorId: user.id,
      actorEmail: user.email,
      kbId: knowledgeBase.id,
      target: knowledgeBase.name,
      ip: clientIp(request),
    });

    return NextResponse.json(knowledgeBase);
  } catch (error) {
    return toResponse(error, 'Failed to create knowledge base');
  }
}
