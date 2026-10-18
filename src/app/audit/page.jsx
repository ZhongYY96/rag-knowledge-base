import Link from 'next/link';
import { Shield } from 'lucide-react';
import { requirePageUser } from '@/lib/auth/pageGuard';
import { listKnowledgeBasesForUser } from '@/lib/database';
import { listAudit, auditLabel, AUDIT_LABELS } from '@/lib/audit';

/**
 * 审计日志（页面）。
 *
 * 可见范围：自己做的事 + 发生在自己有权限的知识库里的事。
 * 没有"管理员看所有"——这个 demo 没有全局角色，宁可少看也不越权。
 */
const RESULT_STYLE = {
  ok: 'bg-green-50 text-green-700',
  denied: 'bg-red-50 text-red-700',
  error: 'bg-amber-50 text-amber-700',
};
const RESULT_TEXT = { ok: '成功', denied: '被拒', error: '异常' };

const fmt = (ts) => new Date(Number(ts)).toLocaleString();

export default async function AuditPage({ searchParams }) {
  const user = await requirePageUser('/audit');
  const sp = (await searchParams) || {};
  const action = typeof sp.action === 'string' ? sp.action : '';
  const kbId = typeof sp.kbId === 'string' ? sp.kbId : '';

  const kbs = await listKnowledgeBasesForUser(user.id);
  const items = await listAudit({
    limit: 200,
    action: action || null,
    kbId: kbId || null,
    selfId: user.id,
    allowedKbIds: kbs.map((k) => k.id),
  });

  return (
    <div className="p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-blue-600" />
            <h1 className="text-2xl font-bold text-blue-600">审计日志</h1>
            <span className="text-xs text-gray-400">最近 {items.length} 条 · 只显示与您相关的记录</span>
          </div>
        </div>

        {/* 过滤：用 GET 表单，刷新/分享链接都能保留筛选条件 */}
        <form className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-white p-3" method="get">
          <select
            name="action"
            defaultValue={action}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">全部操作</option>
            {Object.entries(AUDIT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          <select
            name="kbId"
            defaultValue={kbId}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">全部知识库</option>
            {kbs.map((kb) => (
              <option key={kb.id} value={kb.id}>
                {kb.name}
              </option>
            ))}
          </select>

          <button
            type="submit"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            筛选
          </button>

          {(action || kbId) && (
            <Link href="/audit" className="text-sm text-gray-500 hover:text-gray-800">
              清空筛选
            </Link>
          )}
        </form>

        {items.length === 0 ? (
          <div className="rounded-lg border bg-white p-10 text-center text-sm text-gray-500">
            暂无审计记录。做点什么（登录、建库、上传、改设置）就会出现在这里。
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                  <th className="px-3 py-2 font-medium">对象</th>
                  <th className="px-3 py-2 font-medium">结果</th>
                  <th className="px-3 py-2 font-medium">操作者</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                  <th className="px-3 py-2 font-medium">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((e) => {
                  const kb = kbs.find((k) => k.id === e.kbId);
                  return (
                    <tr key={e.id} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">{fmt(e.ts)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-800">{auditLabel(e.action)}</td>
                      <td className="max-w-[16rem] px-3 py-2">
                        <div className="truncate text-gray-700" title={e.target || ''}>
                          {kb ? kb.name : e.target || '—'}
                        </div>
                        {kb && e.target && (
                          <div className="truncate text-xs text-gray-400" title={e.target}>
                            {e.target}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] ${RESULT_STYLE[e.result] || 'bg-gray-100 text-gray-600'}`}
                        >
                          {RESULT_TEXT[e.result] || e.result}
                        </span>
                      </td>
                      <td className="max-w-[12rem] truncate px-3 py-2 text-xs text-gray-600">
                        {e.actorEmail || e.actorId || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-400">{e.ip || '—'}</td>
                      <td className="max-w-[14rem] px-3 py-2">
                        {e.meta ? (
                          <span
                            className="block truncate text-xs text-gray-400"
                            title={JSON.stringify(e.meta)}
                          >
                            {JSON.stringify(e.meta)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
