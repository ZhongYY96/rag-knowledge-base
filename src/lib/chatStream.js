import { redis } from '@/lib/redis';

/**
 * 生成过程的增量通道（Redis Stream）。
 *
 * 为什么需要它：after() 里跑流式生成时，HTTP 响应已经关闭，
 * token 没有出口。所以写进 Stream，浏览器再用 SSE 来读——
 * 这样「任务」和「观看者」彻底解耦：
 *   · 切页面 = 关掉观看者，任务照跑
 *   · 回来 = 新开一个观看者，从 Stream 回放已有内容再追尾
 *   · 多个标签页 = 多个观看者看同一条流
 */
const streamKey = (sessionId) => `chat:stream:${sessionId}`;
const TTL = 60 * 60;
const MAXLEN = 4000;

export async function appendDelta(sessionId, delta) {
  if (!delta) return;
  await redis.xadd(streamKey(sessionId), 'MAXLEN', '~', MAXLEN, '*', 'd', delta);
  await redis.expire(streamKey(sessionId), TTL);
}

export async function markDone(sessionId, payload = '1') {
  await redis.xadd(streamKey(sessionId), 'MAXLEN', '~', MAXLEN, '*', 'done', payload);
  await redis.expire(streamKey(sessionId), TTL);
}

/** 读 lastId 之后的所有增量（非阻塞，SSE 循环用小间隔轮询） */
export async function readAfter(sessionId, lastId = '0-0', count = 200) {
  const rows = await redis.xrange(streamKey(sessionId), `(${lastId}`, '+', 'COUNT', count);
  return rows.map(([id, fields]) => {
    const map = {};
    for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
    return { id, delta: map.d ?? null, done: map.done ?? null };
  });
}

export async function clearStream(sessionId) {
  await redis.del(streamKey(sessionId));
}
