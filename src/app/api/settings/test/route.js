import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { toResponse } from '@/lib/auth/errors';
import { getSettings, chatConfig, embeddingConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 20000;

async function postJson(url, payload, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 本地服务不校验 key，但很多云端 gateway 要求非空
        Authorization: `Bearer ${apiKey || 'local'}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 响应，下面按错误处理 */
    }
    return { res, data, text, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/settings/test  { kind: 'chat' | 'embedding' }
 *
 * 用**已保存的**配置打一次最小请求。这样测试和实际使用走的是同一份配置，
 * 不会出现「测试通过、对话失败」——那种情况通常是前端表单还没保存。
 */
export async function POST(request) {
  try {
    const user = await requireUser();
    const { kind = 'chat' } = await request.json().catch(() => ({}));
    const settings = await getSettings(user.id);

    if (kind === 'embedding') {
      const cfg = embeddingConfig(settings);
      const { res, data, text, ms } = await postJson(
        `${cfg.baseUrl}/embeddings`,
        { model: cfg.model, input: 'ping' },
        cfg.apiKey,
      );
      if (!res.ok) {
        return NextResponse.json(
          { ok: false, latencyMs: ms, error: `HTTP ${res.status}`, detail: (text || '').slice(0, 300) },
          { status: 200 },
        );
      }
      const dim = data?.data?.[0]?.embedding?.length ?? 0;
      return NextResponse.json({
        ok: true,
        latencyMs: ms,
        message: `返回 ${dim} 维向量`,
        warning:
          dim && dim !== cfg.vectorSize
            ? `实际维度 ${dim} 与设置里的 ${cfg.vectorSize} 不一致，请改正后再上传文档`
            : null,
      });
    }

    const cfg = chatConfig(settings);
    const { res, data, text, ms } = await postJson(
      `${cfg.baseUrl}/chat/completions`,
      { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 },
      cfg.apiKey,
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, latencyMs: ms, error: `HTTP ${res.status}`, detail: (text || '').slice(0, 300) },
        { status: 200 },
      );
    }
    const msg = data?.choices?.[0]?.message;
    return NextResponse.json({
      ok: true,
      latencyMs: ms,
      message: (msg?.content || msg?.reasoning_content || '(空回复)').slice(0, 80),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return NextResponse.json({ ok: false, error: '请求超时（20s）' }, { status: 200 });
    }
    return toResponse(error, '连接测试失败');
  }
}
