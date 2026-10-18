import { NextResponse } from 'next/server';
import { after } from 'next/server';
import path from 'node:path';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getSettings, ragConfig, embeddingConfigForKb } from '@/lib/settings';
import { getVectorStore } from '@/lib/vectorStore';
import { judgeRetrieval, summarize, saveReport } from '@/lib/rag/eval';
import { resolveCases, runFullEval, getJob } from '@/lib/rag/evalJob';
import { audit, clientIp } from '@/lib/audit';

export const dynamic = 'force-dynamic';
// 完整评测要调模型，给足时间（仅自托管 Node 有效；Vercel 上要配 maxDuration）
export const maxDuration = 600;

/**
 * POST /api/eval/run { knowledgeBaseId, mode: 'retrieval' | 'full' }
 *
 * retrieval（默认）：只跑检索层，1 秒内同步返回，页面立刻出命中率
 * full：检索 + 生成，异步跑（after），立刻返回 202 + job，页面轮询进度
 *
 * 为什么要分成两种：完整评测 8 条约 2 分钟、50 条约 20 分钟，
 * 同步请求必然超时，用户也看不到进度。
 */
export async function POST(request) {
  try {
    const user = await requireUser();
    const body = await request.json().catch(() => ({}));
    const knowledgeBaseId = body.knowledgeBaseId;
    const mode = body.mode === 'full' ? 'full' : 'retrieval';

    if (!knowledgeBaseId) throw new HttpError(400, '缺少 knowledgeBaseId');
    const { kb } = await requireKb(knowledgeBaseId, user.id, 'viewer');

    // ── 完整评测：起后台任务，立刻返回 ──
    if (mode === 'full') {
      const running = await getJob(knowledgeBaseId);
      if (running?.status === 'running') {
        return NextResponse.json({ job: running, alreadyRunning: true }, { status: 202 });
      }

      const { cases } = await resolveCases(knowledgeBaseId);

      await audit({
        action: 'eval.run',
        actorId: user.id,
        actorEmail: user.email,
        kbId: knowledgeBaseId,
        target: '完整评测（含生成）',
        ip: clientIp(request),
        meta: { cases: cases.length },
      });
      // 先把 job 标记为 running 再返回，避免页面轮询到空状态
      await after(async () => {
        await runFullEval({
          kbId: knowledgeBaseId,
          kbName: kb.name,
          userId: user.id,
          mode: 'full',
        });
      });

      return NextResponse.json(
        { job: { status: 'running', progress: 0, total: cases.length } },
        { status: 202 },
      );
    }

    // ── 快速检查：同步跑检索层 ──
    const settings = await getSettings(user.id);
    const rag = ragConfig(settings);
    const embedding = await embeddingConfigForKb(knowledgeBaseId, settings);
    const store = await getVectorStore(knowledgeBaseId, embedding, rag);
    const { cases, source } = await resolveCases(knowledgeBaseId);

    const results = [];
    for (const c of cases) {
      const hits = await store.similaritySearchWithScore(c.question, rag.topK);
      results.push({
        id: c.id,
        tier: c.tier,
        question: c.question,
        shouldRefuse: c.should_refuse === true,
        ...judgeRetrieval({
          hits,
          gold: c.gold,
          topK: rag.topK,
          scoreThreshold: rag.scoreThreshold,
        }),
      });
    }

    const tiers = summarize(results);
    const report = {
      at: new Date().toISOString(),
      kbId: knowledgeBaseId,
      kbName: kb.name,
      mode: 'retrieval-only',
      source: 'ui',
      goldenSource: source,
      goldenCount: cases.length,
      config: { ...rag, embedding },
      tiers,
      results,
    };
    const file = await saveReport(report);

    await audit({
      action: 'eval.run',
      actorId: user.id,
      actorEmail: user.email,
      kbId: knowledgeBaseId,
      target: '检索层快速检查',
      ip: clientIp(request),
      meta: { cases: cases.length },
    });
    return NextResponse.json({ report: { ...report, file: path.basename(file) } });
  } catch (error) {
    return toResponse(error, '评测失败');
  }
}
