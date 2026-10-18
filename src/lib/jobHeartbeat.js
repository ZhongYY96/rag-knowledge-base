import { redis } from '@/lib/redis';

/**
 * 任务心跳。
 *
 * 为什么不用「进程启动时间」判断孤儿任务：Next 会把不同路由打成不同 bundle，
 * 同一个模块可能被复制成多份，模块级的 BOOT_TIME 并不唯一（实测直接误判）。
 *
 * 心跳才可靠：跑任务的进程每 5 秒续一次 TTL=20 秒的键。
 *   · 键在 → 确实有进程在跑
 *   · 键没了 → 跑它的进程已经死了（崩溃/重启/被杀）
 */
const TTL = 20;
const INTERVAL = 5000;

const key = (kind, id) => `job:hb:${kind}:${id}`;

export async function isAlive(kind, id) {
  return (await redis.exists(key(kind, id))) === 1;
}

/** 开始心跳，返回停止函数 */
export function startHeartbeat(kind, id) {
  const k = key(kind, id);
  const tick = () => redis.set(k, '1', 'EX', TTL).catch(() => {});
  tick();
  const timer = setInterval(tick, INTERVAL);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await redis.del(k).catch(() => {});
  };
}
