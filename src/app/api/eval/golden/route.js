import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import {
  getGolden,
  saveGolden,
  clearGolden,
  parseGoldenFile,
  GOLDEN_TEMPLATE_CSV,
} from '@/lib/rag/goldenStore';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * 评测集（按知识库）
 *
 * GET    /api/eval/golden?knowledgeBaseId=xxx     查当前用的是哪套、几条
 * GET    /api/eval/golden?template=1              下载 CSV 模板
 * POST   /api/eval/golden                         上传（multipart，file + knowledgeBaseId）
 * DELETE /api/eval/golden?knowledgeBaseId=xxx     清空，回落到内置示例
 *
 * 权限：读要 viewer，改要 editor —— 测试集是库的资产，不能谁都能覆盖。
 */
export async function GET(request) {
  try {
    const url = new URL(request.url);

    if (url.searchParams.get('template') === '1') {
      return new NextResponse(GOLDEN_TEMPLATE_CSV, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="golden-template.csv"',
        },
      });
    }

    const user = await requireUser();
    const knowledgeBaseId = url.searchParams.get('knowledgeBaseId');
    if (!knowledgeBaseId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(knowledgeBaseId, user.id, 'viewer');

    const uploaded = await getGolden(knowledgeBaseId);
    return NextResponse.json({
      count: uploaded?.length ?? 0,
      source: uploaded ? 'uploaded' : 'builtin',
      preview: (uploaded ?? []).slice(0, 3),
    });
  } catch (error) {
    return toResponse(error, '读取测试集失败');
  }
}

export async function POST(request) {
  try {
    const user = await requireUser();
    const form = await request.formData();

    const knowledgeBaseId = form.get('knowledgeBaseId');
    if (!knowledgeBaseId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(String(knowledgeBaseId), user.id, 'editor');

    const file = form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, '没有收到文件');

    const text = await file.text();
    const { cases, errors } = parseGoldenFile(text, file.name);
    if (!cases.length) {
      throw new HttpError(400, errors[0] || '没有解析出有效条目（需要 question 列）');
    }

    await saveGolden(knowledgeBaseId, cases);

    await audit({
      action: 'eval.golden_import',
      actorId: user.id,
      actorEmail: user.email,
      kbId: String(knowledgeBaseId),
      target: file.name,
      ip: clientIp(request),
      meta: { count: cases.length, skipped: errors.length },
    });
    return NextResponse.json({ count: cases.length, errors });
  } catch (error) {
    return toResponse(error, '上传测试集失败');
  }
}

export async function DELETE(request) {
  try {
    const user = await requireUser();
    const knowledgeBaseId = new URL(request.url).searchParams.get('knowledgeBaseId');
    if (!knowledgeBaseId) throw new HttpError(400, '缺少 knowledgeBaseId');
    await requireKb(knowledgeBaseId, user.id, 'editor');

    await clearGolden(knowledgeBaseId);

    await audit({
      action: 'eval.golden_clear',
      actorId: user.id,
      actorEmail: user.email,
      kbId: knowledgeBaseId,
      target: '测试集',
      ip: clientIp(request),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return toResponse(error, '清空测试集失败');
  }
}
