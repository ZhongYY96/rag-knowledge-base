import Redis from 'ioredis';

/**
 * ioredis 单例。
 *
 * 为什么必须缓存到 globalThis：Next.js dev 模式的 HMR 会反复重新执行模块，
 * 每次都 new 一个客户端会不断泄漏连接，直到 Redis 的 maxclients 打满。
 * 这个套路和 Prisma 的 globalThis 单例是一样的。
 */
const globalForRedis = globalThis;

export const redis =
  globalForRedis.__redis ??
  new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    // 单条命令最多重试 3 次，避免请求挂死
    maxRetriesPerRequest: 3,
    // 连不上时不要无限重连刷日志
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });

// ioredis 在连接出错时会 emit 'error'，没有监听器会直接让进程崩掉
redis.on('error', (err) => {
  console.error('[redis] 连接错误:', err.message);
});

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.__redis = redis;
}

/**
 * ⚠️ 从 @upstash/redis 迁到 ioredis 唯一需要留意的语义差异：
 *
 *   key 不存在时，Upstash 的 hgetall 返回 null，而 ioredis 返回 {}
 *
 * 原代码里到处是 `if (!kb) return null` 的存在性判断，而 {} 是 truthy，
 * 这些判断会全部失效（返回一个空对象而不是 null，页面上就会显示一条空记录）。
 * 所以统一换成这个守卫。
 */
export const isMissingHash = (hash) =>
  !hash || typeof hash !== 'object' || Object.keys(hash).length === 0;
