import Link from 'next/link';
import { Activity, ArrowLeft } from 'lucide-react';
import { requirePageUser } from '@/lib/auth/pageGuard';
import { listKnowledgeBasesForUser } from '@/lib/database';
import { costEnabled, getSummary, listCalls, getBudgets } from '@/lib/cost/client';
import BudgetForm from './BudgetForm';

export const dynamic = 'force-dynamic';

const usd = (micro) => `$${(Number(micro || 0) / 1_000_000).toFixed(6)}`;
const num = (n) => Number(n || 0).toLocaleString();

export default async function ObservabilityPage({ searchParams }) {
  const user = await requirePageUser('/observability');
  const sp = (await searchParams) || {};
  const kbs = await listKnowledgeBasesForUser(user.id);

  if (!kbs.length) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-blue-600">调用观测</h1>
        <p className="mt-4 text-sm text-gray-500">还没有知识库，先去建一个再来。</p>
      </div>
    );
  }

  const kbId = typeof sp.kb === 'string' ? sp.kb : kbs[0].id;
  const kb = kbs.find((k) => k.id === kbId) || kbs[0];

  if (!costEnabled()) {
    return (
      <div className="p-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-blue-600">
          <Activity size={20} /> 调用观测
        </h1>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          成本服务未启用。启动 <code className="rounded bg-white px-1">backend/</code> 后，在
          <code className="mx-1 rounded bg-white px-1">.env.local</code> 设置
          <code className="mx-1 rounded bg-white px-1">COST_API_URL=http://127.0.0.1:8100</code>
          并重启开发服务器。
        </div>
      </div>
    );
  }

  let summary = null;
  let calls = [];
  let budgets = [];
  let error = '';
  try {
    [summary, { items: calls }, { items: budgets }] = await Promise.all([
      getSummary(kb.id, 7),
      listCalls(kb.id, { days: 7, limit: 30 }),
      getBudgets(kb.id),
    ]);
  } catch (e) {
    error = e.message;
  }

  const budget = budgets?.[0];

  return (
    <div className="p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-blue-600">
              <Activity size={20} /> 调用观测
            </h1>
            <p className="mt-1 text-xs text-gray-500">
              数据来自成本服务（backend/），按知识库归因，最近 7 天
            </p>
          </div>
          <Link href="/" className="inline-flex items-center text-sm text-gray-500 hover:text-blue-600">
            <ArrowLeft size={14} className="mr-1" /> 返回工作台
          </Link>
        </div>

        {/* 知识库切换 */}
        <div className="mb-4 flex flex-wrap gap-2">
          {kbs.map((k) => (
            <Link
              key={k.id}
              href={`/observability?kb=${k.id}`}
              className={`rounded-md border px-2.5 py-1 text-sm ${
                k.id === kb.id
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {k.name}
            </Link>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            读取成本服务失败：{error}
          </div>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ['调用次数', num(summary.calls)],
                ['等效成本', usd(summary.cost_micro_usd)],
                ['P95 延迟', summary.p95_latency_ms ? `${(summary.p95_latency_ms / 1000).toFixed(1)}s` : '—'],
                ['Tokens', `${num(summary.prompt_tokens)} / ${num(summary.completion_tokens)}`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border bg-white p-4">
                  <p className="text-xs text-gray-500">{label}</p>
                  <p className="mt-1 text-xl font-semibold text-gray-900">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border bg-white p-4">
                <h2 className="mb-3 text-sm font-medium text-gray-700">按模型</h2>
                {summary.by_model.length === 0 ? (
                  <p className="text-sm text-gray-400">还没有调用记录</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-gray-500">
                      <tr>
                        <th className="pb-2 font-medium">模型</th>
                        <th className="pb-2 font-medium">调用</th>
                        <th className="pb-2 font-medium">成本</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {summary.by_model.map((m) => (
                        <tr key={m.model}>
                          <td className="py-1.5 text-gray-800">{m.model}</td>
                          <td className="py-1.5 text-gray-600">{m.calls}</td>
                          <td className="py-1.5 text-gray-600">{usd(m.cost_micro_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="rounded-lg border bg-white p-4">
                <h2 className="mb-3 text-sm font-medium text-gray-700">预算</h2>
                {budget ? (
                  <p className="mb-3 text-sm text-gray-600">
                    每日上限 <b>{usd(budget.limit_micro_usd)}</b>，超限动作{' '}
                    <b>{budget.action}</b>，告警阈值 {budget.warn_at_pct}%
                  </p>
                ) : (
                  <p className="mb-3 text-sm text-gray-500">未设置预算（不做拦截）</p>
                )}
                <BudgetForm kbId={kb.id} initial={budget} />
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border bg-white">
              <div className="border-b px-4 py-3 text-sm font-medium text-gray-700">最近调用</div>
              {calls.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-400">还没有调用记录，去对话页问一个问题</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">时间</th>
                      <th className="px-3 py-2 font-medium">模型</th>
                      <th className="px-3 py-2 font-medium">Tokens(入/出)</th>
                      <th className="px-3 py-2 font-medium">检索</th>
                      <th className="px-3 py-2 font-medium">首字</th>
                      <th className="px-3 py-2 font-medium">总耗时</th>
                      <th className="px-3 py-2 font-medium">成本</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {calls.map((c) => (
                      <tr key={c.id}>
                        <td className="whitespace-nowrap px-3 py-1.5 text-xs text-gray-500">
                          {new Date(c.ts).toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-gray-800">{c.model}</td>
                        <td className="px-3 py-1.5 text-gray-600">
                          {c.prompt_tokens} / {c.completion_tokens}
                        </td>
                        <td className="px-3 py-1.5 text-gray-600">{c.retrieval_ms ?? '—'}ms</td>
                        <td className="px-3 py-1.5 text-gray-600">{c.ttft_ms ? `${c.ttft_ms}ms` : '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600">
                          {c.latency_ms ? `${(c.latency_ms / 1000).toFixed(1)}s` : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-gray-600">{usd(c.cost_micro_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
