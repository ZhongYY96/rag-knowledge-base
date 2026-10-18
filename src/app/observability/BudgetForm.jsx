'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ACTIONS = ['WARN', 'THROTTLE', 'DOWNGRADE', 'BLOCK'];

export default function BudgetForm({ kbId, initial }) {
  const router = useRouter();
  const [limit, setLimit] = useState(
    initial ? (initial.limit_micro_usd / 1_000_000).toString() : '1',
  );
  const [action, setAction] = useState(initial?.action || 'WARN');
  const [warnAt, setWarnAt] = useState(initial?.warn_at_pct ?? 80);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/observability/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledgeBaseId: kbId,
          limit_micro_usd: Math.round(Number(limit) * 1_000_000),
          action,
          warn_at_pct: Number(warnAt),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      setMsg('已保存');
      router.refresh();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-gray-500">
        每日上限（美元）
        <input
          type="number"
          step="0.01"
          min="0"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          className="ml-1 w-20 rounded border border-gray-300 px-1.5 py-1 text-sm"
        />
      </label>
      <label className="text-xs text-gray-500">
        超限动作
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="ml-1 rounded border border-gray-300 px-1.5 py-1 text-sm"
        >
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-gray-500">
        告警阈值%
        <input
          type="number"
          min="1"
          max="100"
          value={warnAt}
          onChange={(e) => setWarnAt(e.target.value)}
          className="ml-1 w-16 rounded border border-gray-300 px-1.5 py-1 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存'}
      </button>
      {msg && <span className="text-xs text-gray-500">{msg}</span>}
    </form>
  );
}
