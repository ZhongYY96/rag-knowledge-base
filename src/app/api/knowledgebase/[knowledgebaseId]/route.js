import { NextResponse } from 'next/server';
import { deleteKnowledgeBase } from '@/lib/database';
import { dropKnowledgeBaseVectors } from '@/lib/vectorStore';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse } from '@/lib/auth/errors';
import { audit, clientIp } from '@/lib/audit';

/**
 * 鉴权两行：requireUser()（401）+ requireKb(...)（无权限 404）。
 * DELETE 必须 owner —— 能看≠能删。
 */
export async function DELETE(request, { params }) {
  try {
    const user = await requireUser();
    // Next.js 15 起 params 是 Promise
    const { knowledgebaseId } = await params;
    await requireKb(knowledgebaseId, user.id, 'owner');

    await deleteKnowledgeBase(knowledgebaseId);

    // 原实现只删了 Redis 里的记录，Qdrant 里的向量会一直残留
    await dropKnowledgeBaseVectors(knowledgebaseId);

    await audit({
      action: 'kb.delete',
      actorId: user.id,
      actorEmail: user.email,
      kbId: knowledgebaseId,
      target: '知识库及其全部文档',
      ip: clientIp(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return toResponse(error, 'Failed to delete knowledge base');
  }
}

export async function GET(request, { params }) {
  try {
    const user = await requireUser();
    const { knowledgebaseId } = await params;

    const { kb, role } = await requireKb(knowledgebaseId, user.id, 'viewer');
    return NextResponse.json({ ...kb, role });
  } catch (error) {
    return toResponse(error, 'Failed to fetch knowledge base');
  }
}
