import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import { toResponse, HttpError } from '@/lib/auth/errors';
import { getSessionBundle } from '@/lib/chatSessions';
import { readAfter } from '@/lib/chatStream';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /api/chat/sessions/[id]/stream —— SSE 增量流
 *
 * 不产生内容，只是「Redis Stream 的观看者」：
 *   1. 从 Last-Event-ID（或 ?from=）开始回放
 *   2. 没新数据就 100ms 轮询一次（越小越顺，代价是 Redis 轮询变密）
 *   3. 看到 done 标记就收尾；任务已结束但没 done（异常）也收尾
 *   4. 顺带每 8 秒发一次心跳注释，防代理掐连接
 *
 * 断开连接只影响这个观看者，后台任务照跑。
 */
export async function GET(request, { params }) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const bundle = await getSessionBundle(id);
    if (!bundle) throw new HttpError(404, '会话不存在');
    await requireKb(bundle.session.knowledgeBaseId, user.id, 'viewer');

    const url = new URL(request.url);
    let lastId = request.headers.get('last-event-id') || url.searchParams.get('from') || '0-0';

    const encoder = new TextEncoder();
    let cancelled = false;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (frame) => {
          if (cancelled) return;
          controller.enqueue(encoder.encode(frame));
        };
        const sendDelta = (evtId, delta) =>
          send(`id: ${evtId}\nevent: delta\ndata: ${JSON.stringify({ d: delta })}\n\n`);
        const sendDone = (payload) =>
          send(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);

        let idleSince = Date.now();
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {}
        };

        try {
          while (!cancelled && !request.signal.aborted) {
            const items = await readAfter(id, lastId, 200);

            if (items.length) {
              idleSince = Date.now();
              for (const item of items) {
                lastId = item.id;
                if (item.done) {
                  sendDone({ ok: item.done !== 'error' });
                  finish();
                  return;
                }
                if (item.delta) sendDelta(item.id, item.delta);
              }
              continue;
            }

            // 没有新数据：任务结束了吗
            const job = bundle.job && (await getSessionBundle(id))?.job;
            if (!job || job.status !== 'running') {
              sendDone({ ok: job?.status !== 'failed', status: job?.status ?? 'unknown' });
              finish();
              return;
            }

            if (Date.now() - idleSince > 8000) {
              idleSince = Date.now();
              send(`: ping\n\n`);
            }
            await sleep(100);
          }
          finish();
        } catch (error) {
          console.warn('[stream] 断开:', error.message);
          finish();
        }
      },
      cancel() {
        // 浏览器断开 / 切页面：只停止推送，不影响后台任务
        cancelled = true;
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return toResponse(error, '读取流失败');
  }
}
