import { redis } from '@/lib/redis';
import { getVectorStore } from '@/lib/vectorStore';
import { generateAnswer } from '@/lib/rag/run';
import { startHeartbeat } from '@/lib/jobHeartbeat';
import { isAlive } from '@/lib/jobHeartbeat';
import { getSettings, chatConfig, embeddingConfigForKb, ragConfig } from '@/lib/settings';
import { judgeRetrieval, judgeAnswer, summarize, saveReport, loadGolden } from './eval';
import { getGolden } from './goldenStore';

/**
 * 异步评测任务。
 *
 * 为什么必须异步：完整评测要调模型，8 条约 2 分钟，50 条约 20 分钟。
 * 同步 HTTP 请求必然超时，页面也没法显示进度。
 *
 * 任务状态存在 Redis（`eval:job:{kbId}`），页面轮询 GET /api/eval/job。
 * 单进程部署时其实用内存 Map 也行，但放 Redis 以后扩实例不用改。
 */

const jobKey = (kbId) => `eval:job:${kbId}`;
const JOB_TTL = 60 * 60; // 1 小时后自动清掉

const STALE_EVAL_MS = 30 * 60 * 1000;

export async function getJob(kbId) {
  const raw = await redis.get(jobKey(kbId));
  if (!raw) return null;
  try {
    const job = JSON.parse(raw);
    if (job.status !== 'running') return job;

    // 孤儿任务：状态说在跑，但心跳已过期 → 跑它的进程没了
    const age = Date.now() - Number(job.startedAtMs || 0);
    // 30 秒宽限：任务刚起来时心跳可能还没落地，不能立刻判死
    const orphaned = age > 30_000 && !(await isAlive('eval', kbId));
    const tooOld = age > STALE_EVAL_MS;
    if (orphaned || tooOld) {
      const stale = {
        ...job,
        status: 'failed',
        error: orphaned ? '服务重启导致评测中断' : '评测超时',
        finishedAt: new Date().toISOString(),
      };
      await redis.set(jobKey(kbId), JSON.stringify(stale), 'EX', JOB_TTL);
      return stale;
    }
    return job;
  } catch {
    return null;
  }
}

async function saveJob(kbId, job) {
  await redis.set(jobKey(kbId), JSON.stringify(job), 'EX', JOB_TTL);
}

export async function clearJob(kbId) {
  await redis.del(jobKey(kbId));
}

/** 把测试集准备好（上传的优先，否则内置示例） */
export async function resolveCases(kbId) {
  const uploaded = await getGolden(kbId);
  if (uploaded) return { cases: uploaded, source: 'uploaded' };
  return { cases: await loadGolden(), source: 'builtin' };
}

/**
 * 跑一次完整评测（检索 + 生成），全程更新进度。
 * 调用方负责不阻塞请求（用 after() 或 fire-and-forget）。
 */
export async function runFullEval({ kbId, kbName, userId, mode = 'full' }) {
  // 心跳必须在最前面开始：否则任务刚启动的几秒内会被误判成孤儿
  const stopHeartbeat = startHeartbeat('eval', kbId);
  const startedAt = new Date().toISOString();
  const { cases, source } = await resolveCases(kbId);

  const job = {
    id: `job_${Date.now()}`,
    kbId,
    kbName,
    mode,
    status: 'running',
    progress: 0,
    total: cases.length,
    startedAt,
    startedAtMs: Date.now(),
    current: '',
  };
  await saveJob(kbId, job);

  try {
    const settings = await getSettings(userId);
    const chat = chatConfig(settings);
    const embedding = await embeddingConfigForKb(kbId, settings);
    const rag = ragConfig(settings);
    const store = await getVectorStore(kbId, embedding, rag);

    // 生成走 AI SDK（见 generateAnswer 的注释：LangChain 的 chain 在 after() 里会挂住）

    const results = [];
    for (const [i, c] of cases.entries()) {
      job.progress = i;
      job.current = c.question.slice(0, 40);
      await saveJob(kbId, job);

      const hits = await store.similaritySearchWithScore(c.question, rag.topK);
      const row = {
        id: c.id,
        tier: c.tier,
        question: c.question,
        shouldRefuse: c.should_refuse === true,
        ...judgeRetrieval({ hits, gold: c.gold, topK: rag.topK, scoreThreshold: rag.scoreThreshold }),
      };

      if (mode === 'full') {
        const docs = hits.map(([doc]) => doc);
        const answer = await generateAnswer({ chat, question: c.question, docs });
        row.answer = answer;
        Object.assign(
          row,
          judgeAnswer({ answer, docs, shouldRefuse: row.shouldRefuse, mustContain: c.must_contain }),
        );
      }
      results.push(row);
    }

    const tiers = summarize(results);
    const file = await saveReport({
      at: new Date().toISOString(),
      kbId,
      kbName,
      mode: mode === 'full' ? 'full' : 'retrieval-only',
      source: 'ui',
      goldenSource: source,
      goldenCount: cases.length,
      config: { ...rag, chat: { model: chat.model, baseUrl: chat.baseUrl }, embedding },
      tiers,
      results,
    });

    await saveJob(kbId, {
      ...job,
      status: 'done',
      progress: cases.length,
      current: '',
      finishedAt: new Date().toISOString(),
      reportFile: file.split('/').pop(),
      tiers,
    });
    return { ok: true, file };
  } catch (error) {
    console.error('[eval] 任务失败:', error);
    await saveJob(kbId, {
      ...job,
      status: 'failed',
      error: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    });
    return { ok: false, error };
  }
}
