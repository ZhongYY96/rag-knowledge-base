import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { toResponse } from '@/lib/auth/errors';
import { getSettings, saveSettings, toPublicSettings } from '@/lib/settings';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** GET /api/settings —— key 已掩码 */
export async function GET() {
  try {
    const user = await requireUser();
    const settings = await getSettings(user.id);
    return NextResponse.json(toPublicSettings(settings));
  } catch (error) {
    return toResponse(error, '读取设置失败');
  }
}

/** PUT /api/settings —— 部分更新；apiKey 传空表示不改 */
export async function PUT(request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const next = await saveSettings(user.id, body || {});

    await audit({
      action: 'settings.update',
      actorId: user.id,
      actorEmail: user.email,
      target: '模型与检索参数',
      ip: clientIp(request),
      // 只记改了哪些字段，不记值（值里可能含 key）
      meta: { fields: Object.keys(body || {}) },
    });
    return NextResponse.json(toPublicSettings(next));
  } catch (error) {
    if (error?.message && !error.status) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return toResponse(error, '保存设置失败');
  }
}
