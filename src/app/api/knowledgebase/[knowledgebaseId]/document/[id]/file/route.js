import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { getDocument } from '@/lib/database';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse } from '@/lib/auth/errors';

/**
 * GET /api/knowledgebase/[knowledgebaseId]/document/[id]/file
 *
 * 返回**原始上传文件**，供引用卡片里的「查看原文」使用。
 *
 * ⚠️ 路由段名必须是 [id]，和同级的删除接口 document/[id]/route.js 保持一致。
 *    如果这里写成 [documentId]，Next.js 会因为「同一层级出现两个不同名的动态段」
 *    而解析不到，表现是整个接口 404 —— 这个坑已经踩过一次。
 *    所以 params 里解构出来的键也叫 id，下面用别名转成 documentId 方便阅读。
 *
 * ── 安全设计（这是这个接口最重要的部分）──
 *
 * 1) **绝不接受客户端传路径。**
 *    请求里只有 documentId，磁盘路径由服务端从数据库里查回来。
 *    这样客户端没有任何办法指定要读哪个文件。
 *
 * 2) **路径穿越二次防护。**
 *    即使数据库里的 filename 被人为写坏了（比如含 ../），
 *    下面还会校验解析后的绝对路径必须仍在 uploads/ 目录内。
 *
 * 3) **校验文档归属。**
 *    确认这个 documentId 确实属于 URL 里的 knowledgeBaseId，
 *    防止用 A 库的地址读 B 库的文档。
 *
 * 4) **登录 + 库归属鉴权**（本次改造补上）。
 *    之前这个接口完全不校验登录态，任何人拿到 URL 就能下原始文件。
 */
export async function GET(request, { params }) {
  try {
    // 鉴权：未登录 401，无权限 404（在读文件之前就挡住）
    const user = await requireUser();
    // Next.js 15 起 params 是 Promise；段名是 [id]，所以键也叫 id
    const { knowledgebaseId, id: documentId } = await params;

    if (!documentId) {
      return NextResponse.json({ error: '缺少文档 ID' }, { status: 400 });
    }

    await requireKb(knowledgebaseId, user.id, 'viewer');

    // ① 从数据库拿「磁盘文件名」——注意不是客户端传的
    const doc = await getDocument(documentId);
    if (!doc) {
      return NextResponse.json({ error: '找不到这份文档，可能已被删除' }, { status: 404 });
    }

    // ② 归属校验
    if (doc.knowledgeBaseId && doc.knowledgeBaseId !== knowledgebaseId) {
      return NextResponse.json({ error: '这份文档不属于当前知识库' }, { status: 403 });
    }

    // ③ 解析绝对路径，并确认它没有逃出 uploads/
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    const filePath = path.resolve(uploadsDir, doc.filename);
    if (filePath !== uploadsDir && !filePath.startsWith(uploadsDir + path.sep)) {
      console.error('[file] 拦截到越界的文件路径:', doc.filename);
      return NextResponse.json({ error: '文件路径不合法' }, { status: 400 });
    }

    // ④ 读文件
    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 数据库有记录但磁盘上没文件 —— 常见于换机器后 uploads/ 没带过来
        return NextResponse.json(
          { error: '原文件已不在 uploads/ 目录，需要重新上传' },
          { status: 410 },
        );
      }
      throw err;
    }

    // ⑤ 返回。inline 让浏览器直接预览（PDF 会用内置阅读器）
    const contentType = doc.fileType || 'application/octet-stream';
    const originalName = doc.originalName || doc.filename;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        // 用 RFC 5987 的 filename* 才能正确下发中文文件名
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(originalName)}`,
        /*
         * 允许短缓存。
         *
         * 前端「查看原文」会先请求一次做预检（避免 iframe 把 403 的 JSON
         * 当文档渲染），随后 iframe 再请求同一个 URL —— 靠这个头命中缓存，
         * 不会重复下载整个 PDF。
         * 文档重新上传会生成新的 documentId，URL 也就变了，不存在看到旧内容的担心。
         */
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    // 401/403/404 由 toResponse 映射，不再一律 500
    if (error?.status) return toResponse(error, '读取原文件失败');
    console.error('Error serving document file:', error);
    return NextResponse.json({ error: '读取原文件失败' }, { status: 500 });
  }
}
