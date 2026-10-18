import { streamText } from 'ai';
import { createChatProvider } from '@/lib/rag/provider';
import { getSettings, chatConfig, embeddingConfigForKb, ragConfig } from '@/lib/settings';
import { getChatMessages } from '@/lib/database';
import { appendMessage, getJob, saveJob } from '@/lib/chatSessions';
import { appendDelta, markDone, clearStream } from '@/lib/chatStream';
import { startHeartbeat } from '@/lib/jobHeartbeat';
import { retrieveDocs, toSource } from '@/lib/rag/run';
import { historyFor } from '@/lib/rag/followup';
import { preflight, report } from '@/lib/cost/client';
import { estimateTokens } from '@/lib/cost/tokens';
import { ANSWER_SYSTEM_PROMPT, formatContext } from '@/lib/rag/prompt';

/**
 * 跑一轮问答：**在 after() 里执行，流式产出，token 写 Redis Stream**。
 *
 * 这是"任务不停 + 流式"能同时成立的关键：
 *   · 任务：由 after() 托管，不依赖 HTTP 响应
 *   · 流式：token 不推向响应体（那时已经关了），而是写进 Redis Stream
 *   · 观看：浏览器另开 SSE 从 Stream 回放 + 追尾，断开不影响任务
 */
const TURN_TIMEOUT_MS = 240_000;

export async function runSessionTurn({ sessionId, kbId, userId }) {
  const startedAt = Date.now();
  // 硬超时：任何一步卡住都不能让会话永久停在「生成中」
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`生成超时（超过 ${TURN_TIMEOUT_MS / 1000} 秒）`)), TURN_TIMEOUT_MS),
  );
  return Promise.race([runTurnInner({ sessionId, kbId, userId, startedAt }), timeout]).catch(
    async (error) => {
      console.error('[chat] 失败或超时:', error.message);
      try {
        const msg = `生成失败：${error.message}`;
        await appendDelta(sessionId, msg);
        await appendMessage(sessionId, { role: 'assistant', content: msg, sources: [] });
      } catch {}
      await markDone(sessionId, 'error');
      await saveJob(sessionId, { status: 'failed', startedAt, finishedAt: Date.now(), error: error.message });
      return { ok: false };
    },
  );
}

async function runTurnInner({ sessionId, kbId, userId, startedAt }) {
  const log = (m) => console.log(`[chat ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${m}`);
  const stopHeartbeat = startHeartbeat('chat', sessionId);
  const job = (await getJob(sessionId)) || { status: 'running', startedAt };
  log('turn start');

  try {
    // 兜底：确保这一轮从空流开始（正常由 messages 路由清理）
    await clearStream(sessionId);

    const settings = await getSettings(userId);
    const chat = chatConfig(settings);
    const embedding = await embeddingConfigForKb(kbId, settings);
    const rag = ragConfig(settings);

    const messages = await getChatMessages(sessionId);
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') throw new Error('会话里没有待回答的用户消息');
    const history = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));

    log('settings ok, retrieving…');
    const requestId = `req_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
    const tRetrieval0 = Date.now();

    const docs = await retrieveDocs({
      kbId,
      question: last.content,
      history,
      chat,
      embedding,
      rag,
    });

    const retrievalMs = Date.now() - tRetrieval0;
    log(`retrieved ${docs.length} docs`);
    let answer = '';
    let sources = [];

    if (!docs.length) {
      /*
       * 空结果有两种完全不同的原因，提示必须区分开，
       * 否则用户会一直"换问法"，而真正的问题是索引是空的。
       */
      let docCount = 0;
      try {
        const { getDocumentsByKnowledgeBase } = await import('@/lib/database');
        const docs = await getDocumentsByKnowledgeBase(kbId);
        docCount = Array.isArray(docs) ? docs.length : 0;
      } catch {}

      answer = docCount === 0
        ? '这个知识库还没有上传文档。先上传 PDF / TXT / Markdown，再提问。'
        : `这个知识库有 ${docCount} 个文档，但没有检索到向量内容（索引可能为空或正在建立）。可以到知识库详情页确认分块数，或用 scripts/reindex.mjs 重建索引。`;
      await appendDelta(sessionId, answer);
    } else {
      sources = docs.map(toSource);

      /*
       * 两个必须的适配（实测出来的，不是猜的）：
       *
       * 1) 关思考：MiniCPM 这类推理模型默认先吐一堆 reasoning_content。
       *    走 AI SDK 时 reasoning 不会映射成 text-delta —— 实测 200 token 上限下
       *    text 一个字都没有，`result.text` 也永远不 resolve。
       *    注入 chat_template_kwargs.enable_thinking=false 后：34 个 text-delta、5 秒出完。
       *
       * 2) 用 fullStream 消费而不是 await result.text：后者在"只有 reasoning 没有正文"
       *    的情况下会一直挂着（实测 60 秒不返回）。
       */
      /*
       * 生成前预检：把上下文长度估成 prompt tokens，问服务端还能不能花。
       * 返回 DOWNGRADE 时切换到建议模型；服务端挂了一律放行（不拖垮问答）。
       */
      const contextChars = docs.reduce((n, d) => n + (d.pageContent?.length ?? 0), 0);
      const verdict = await preflight({
        tenant_id: kbId,
        feature: 'chat.answer',
        model: chat.model,
        est_prompt_tokens: Math.round(contextChars / 2.5) + 200,
        max_tokens: Number(chat.maxTokens || 512),
      });
      if (verdict.action === 'DOWNGRADE' && verdict.suggested_model) {
        chat.model = verdict.suggested_model;
        log(`预算降级 → ${chat.model}`);
      }

      const provider = createChatProvider(chat);
      const system = ANSWER_SYSTEM_PROMPT.replace('{context}', formatContext(docs));

      // onChunk 是同步回调，用一条 promise 链把「写 Stream」串起来，避免乱序
      let pending = '';
      let flushing = Promise.resolve();
      const flush = () => {
        if (!pending) return;
        const chunk = pending;
        pending = '';
        flushing = flushing.then(() => appendDelta(sessionId, chunk)).catch(() => {});
      };

      const result = streamText({
        // ⚠️ 必须 .chat()：provider(model) 在部分版本会打到 /v1/responses，
        //    而本地 llama.cpp / vLLM 只实现 /v1/chat/completions
        model: provider.chat(chat.model),
        system,
        // 非追问不带历史：否则弱模型会重复回答上一轮的问题
        messages: [...historyFor(last.content, history), { role: 'user', content: last.content }],
        temperature: Number(chat.temperature ?? 0),
        ...(chat.maxTokens ? { maxTokens: Number(chat.maxTokens) } : {}),
      });

      log('streamText start');
      // ★ 显式消费整条流：既不依赖 result.text，也能同时拿到别的 part 类型
      let ttftMs = null;
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          if (ttftMs === null) ttftMs = Date.now() - tRetrieval0 - retrievalMs;
          answer += part.textDelta;
          pending += part.textDelta;
          // 攒够 24 个字符再落一次，避免每个 token 都打一次 Redis
          if (pending.length >= 24) flush();
        } else if (part.type === 'reasoning') {
          log('收到 reasoning 片（说明 enable_thinking 没关掉）');
        } else if (part.type === 'error') {
          throw new Error(part.error?.message || '模型流式返回错误');
        }
      }

      log(`stream done, len=${answer.length}`);
      flush();
      await flushing;

      // 上报用量与耗时（不阻塞主流程）
      try {
        const usage = (await result.usage) || {};
        let promptTokens = Math.round(Number(usage.promptTokens) || 0);
        let completionTokens = Math.round(Number(usage.completionTokens) || 0);
        let estimated = false;

        // 流式响应常常不带 usage：按实际文本估算，否则成本永远是 0
        if (promptTokens === 0) {
          promptTokens = estimateTokens(formatContext(docs)) + estimateTokens(last.content) + 120;
          estimated = true;
        }
        if (completionTokens === 0) {
          completionTokens = estimateTokens(answer);
          estimated = true;
        }
        report({
          request_id: requestId,
          tenant_id: kbId,
          feature: 'chat.answer',
          model: chat.model,
          usage: {
            // 部分 provider 会返回浮点 token 数，服务端要求整数
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
          timings: {
            retrieval_ms: Math.round(retrievalMs),
            ttft_ms: ttftMs === null ? null : Math.round(ttftMs),
            latency_ms: Math.round(Date.now() - startedAt),
          },
          status: 'ok',
          meta: {
            top_k: rag.topK,
            mode: rag.mode,
            sources: docs.length,
            usage_estimated: estimated,
          },
        });
      } catch (e) {
        console.warn('[chat] 用量上报失败:', e.message);
      }
    }

    if (!answer.trim()) {
      answer = '模型这次没有生成有效回答（可能是上下文过长），请重试或换一种问法。';
    }

    await appendMessage(sessionId, { role: 'assistant', content: answer, sources });
    await markDone(sessionId);
    await stopHeartbeat();
    await saveJob(sessionId, {
      ...job,
      status: 'done',
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      mode: rag.mode,
    });
    return { ok: true };
  } catch (error) {
    console.error('[chat] 生成失败:', error);
    try {
      const msg = `生成失败：${error?.message || error}`;
      await appendDelta(sessionId, msg);
      await appendMessage(sessionId, { role: 'assistant', content: msg, sources: [] });
    } catch {}
    await markDone(sessionId, 'error');
    await saveJob(sessionId, {
      ...job,
      status: 'failed',
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      error: error?.message || String(error),
    });
    return { ok: false };
  }
}
