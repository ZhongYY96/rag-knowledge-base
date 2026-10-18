import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { addDocument, updateDocumentChunkCount, updateKnowledgeBase } from '@/lib/database';
import { processDocument } from '@/lib/documentProcessing';
import { getVectorStore } from '@/lib/vectorStore';
import { Document } from '@langchain/core/documents';
import { existsSync } from 'fs';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse } from '@/lib/auth/errors';
import { getSettings, embeddingConfigForKb, ragConfig } from '@/lib/settings';
import { audit, clientIp } from '@/lib/audit';

/**
 * 把原始文件名变成一个安全的、不会互相覆盖的磁盘文件名。
 *
 * 为什么需要：
 *   原来直接用 path.join(uploadsDir, fileName)，两次上传同名文件会**直接覆盖**，
 *   但 Redis 和 Qdrant 里是两条独立记录 —— 引用会指向错误的内容。
 *
 * 做法：时间戳 + 随机串前缀 + 白名单过滤后的原名。
 *   保留原名是为了出问题时能在 uploads/ 里肉眼认出来是谁。
 *   过滤掉 / \ .. 等字符是防路径穿越的第一道防线（第二道在读取接口里）。
 */
function toStoredName(originalName) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  const safeBase = base.replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60);
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `${unique}_${safeBase}${ext}`;
}

export async function POST(request, { params }) {
  try {
    // ① 身份
    const user = await requireUser();
    const settings = await getSettings(user.id);

    const formData = await request.formData();
    const files = formData.getAll('files');

    const knowledgeBaseId = decodeURIComponent(formData.get('knowledgeBaseId'));
    if (!knowledgeBaseId) {
      return NextResponse.json({ error: 'Knowledge base ID is required' }, { status: 400 });
    }

    // ② 归属：必须在读文件之前挡住，否则等于替攻击者白传一遍大文件
    const { kb } = await requireKb(knowledgeBaseId, user.id, 'editor');

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    /*
     * embedding 配置：
     *   - 知识库首次上传时，把当时用的模型 + 维度钉在 kb 上
     *   - 之后上传一律沿用库上的记录（用户改设置只影响新库）
     * 这样换 embedding 模型不会把老索引悄悄写坏。
     */
    const embedding = await embeddingConfigForKb(knowledgeBaseId, settings);
    const rag = ragConfig(settings);

    // 把「这个库是用什么切的 / 用的什么 embedding」记在库上，便于排查和对齐
    if (!kb.embModel || !kb.embVectorSize) {
      await updateKnowledgeBase(knowledgeBaseId, {
        embModel: embedding.model,
        embVectorSize: String(embedding.vectorSize),
      });
    }
    if (!kb.chunkSize) {
      await updateKnowledgeBase(knowledgeBaseId, {
        chunkSize: String(rag.chunkSize),
        chunkOverlap: String(rag.chunkOverlap),
      });
    }

    // 一个知识库对应一个 Qdrant collection（等价于原来的 namespace）
    const vectorStore = await getVectorStore(knowledgeBaseId, embedding);

    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!existsSync(uploadsDir)) {
      await mkdir(uploadsDir, { recursive: true });
    }

    const uploadedDocs = [];
    for (const fileData of files) {
      try {
        if (!fileData) continue;

        const originalName = fileData.name;
        const fileType = fileData.type;
        const fileSize = fileData.size;

        const bytes = await fileData.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // 磁盘名：唯一 + 安全；用户看到的仍是 originalName（存在数据库里）
        const storedName = toStoredName(originalName);
        const filePath = path.join(uploadsDir, storedName);
        await writeFile(filePath, buffer);

        const doc = await addDocument({
          filename: storedName, // 磁盘上的实际文件名 —— 读取接口靠它定位
          originalName, // 用户看到的原始名 —— 引用卡片显示它
          fileType,
          fileSize,
          knowledgeBaseId,
        });

        // 切分参数来自设置：改完只影响之后上传的文档
        const chunks = await processDocument(filePath, fileType, doc.id, originalName, {
          chunkSize: rag.chunkSize,
          chunkOverlap: rag.chunkOverlap,
        });
        const chunkCount = chunks.length;

        const langChainDocs = chunks.map(
          (chunk) =>
            new Document({
              pageContent: chunk.content,
              metadata: {
                // ★ 关键：保留 processDocument 算好的定位字段
                //   （fileName / pageNumber / pageCount / fileType）
                //   原来的写法是只挑 documentId 和 chunkIndex，把 chunk.metadata 整个丢了 ——
                //   结果引用卡片既不知道是哪份文件、也不知道在第几页。
                ...chunk.metadata,
                documentId: doc.id,
                knowledgeBaseId, // 这个 processDocument 不知道，由这里补上
                chunkCount,
              },
            }),
        );

        // 注意：@langchain/community 的 QdrantVectorStore 不支持自定义向量 ID
        // （内部固定用 uuid()），所以传 `{ ids }` 会被静默忽略。
        // 删除走 metadata.documentId 过滤，不依赖 ID 命名规则。
        await vectorStore.addDocuments(langChainDocs);

        // 原来这个函数导出了却从没被调用，导致列表里的分块数一直是空的
        await updateDocumentChunkCount(doc.id, chunkCount);

        uploadedDocs.push({ ...doc, chunkCount });
      } catch (error) {
        console.error(`Error processing file ${fileData?.name || 'unknown'}:`, error);
      }
    }

    await audit({
      action: 'doc.upload',
      actorId: user.id,
      actorEmail: user.email,
      kbId: knowledgeBaseId,
      target: uploadedDocs.map((d) => d.originalName).join(', ').slice(0, 200),
      ip: clientIp(request),
      meta: { count: uploadedDocs.length, chunks: uploadedDocs.reduce((s, d) => s + (d.chunkCount || 0), 0) },
    });

    return NextResponse.json({
      success: true,
      count: uploadedDocs.length,
    });
  } catch (error) {
    return toResponse(error, 'Failed to upload documents');
  }
}
