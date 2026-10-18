/**
 * 成本服务客户端（只在服务端使用）。
 *
 * 三条纪律：
 *   1. 预检 fail-open：本服务不可用时不能拖垮问答
 *   2. 上报 fire-and-forget：失败只记日志
 *   3. 内部 token 只在服务端，浏览器拿不到
 */
const BASE = process.env.COST_API_URL || '';
const TOKEN = process.env.COST_INTERNAL_TOKEN || 'dev-internal-token';

export const costEnabled = () => Boolean(BASE);

async function call(path, { method = 'GET', body, timeoutMs = 1500 } = {}) {
  if (!BASE) throw new Error('COST_API_URL 未配置');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': TOKEN },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      // 把 FastAPI 的校验详情带出来，否则 422 无从排查
      const detail = await res.text().catch(() => '');
      throw new Error(`cost-api ${res.status} ${detail.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 调用前预检：超时或异常一律放行 */
export async function preflight(payload, timeoutMs = 80) {
  if (!BASE) return { action: 'ALLOW', allowed: true, reason: '未启用成本服务' };
  try {
    return await call('/v1/preflight', { method: 'POST', body: payload, timeoutMs });
  } catch {
    return { action: 'ALLOW', allowed: true, reason: '预检不可用，放行' };
  }
}

/** 调用后上报：不 await，失败只记一次日志 */
export function report(payload) {
  if (!BASE) return;
  call('/v1/calls', { method: 'POST', body: payload })
    .catch((e) => console.warn('[cost] 上报失败:', e.message));
}

export const getSummary = (tenantId, days = 7) =>
  call(`/v1/summary?tenant_id=${encodeURIComponent(tenantId)}&days=${days}`);

export const listCalls = (tenantId, { days = 7, limit = 50 } = {}) =>
  call(`/v1/calls?tenant_id=${encodeURIComponent(tenantId)}&days=${days}&limit=${limit}`);

export const getBudgets = (tenantId) =>
  call(`/v1/budgets?tenant_id=${encodeURIComponent(tenantId)}`);

export const putBudget = (payload) => call('/v1/budgets', { method: 'PUT', body: payload });
