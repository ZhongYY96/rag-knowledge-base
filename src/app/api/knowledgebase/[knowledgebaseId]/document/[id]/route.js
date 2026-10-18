import { NextResponse } from 'next/server';
import { deleteDocument, getDocument } from '@/lib/database';
import { deleteDocumentVectors } from '@/lib/vectorStore';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { audit, clientIp } from '@/lib/audit';

/**
 * 删除单个文档。两层校验缺一不可：
 *   ① requireKb：对 URL 里的 kbId 有没有 editor 权限
 *   ② 文档归属：documentId 是不是真属于这个 kbId
 * 只做 ① 不做 ②，就能拿"自己有权限的库"的 URL 去删别人库里的文档。
 */
export async function DELETE(request, { params }) {
  try {
    const user = await requireUser();
    // Next.js 15 起 params 是 Promise
    const { id, knowledgebaseId } = await params;

    if (!id) throw new HttpError(400, 'Document ID is required');

    await requireKb(knowledgebaseId, user.id, 'editor');

    const doc = await getDocument(id);
    if (!doc || doc.knowledgeBaseId !== knowledgebaseId) {
      throw new HttpError(404, 'Document not found');
    }

    await deleteDocument(id);

    // 用 metadata.documentId 过滤删除全部 chunk
    // （原实现是 index.delete({ prefix: id })，前缀匹配属于模糊匹配，容易误伤）
    await deleteDocumentVectors(knowledgebaseId, id);

    await audit({
      action: 'doc.delete',
      actorId: user.id,
      actorEmail: user.email,
      kbId: knowledgebaseId,
      target: doc.originalName || doc.filename || id,
      ip: clientIp(request),
    });

    return NextResponse.json({
      success: true,
      message: `Document ${id} and all associated chunks deleted successfully`,
    });
  } catch (error) {
    if (error instanceof HttpError) return toResponse(error, 'Failed to delete document');
    console.error('Error deleting document:', error);
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
  }
}
