'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Download, Play, RefreshCw, Upload, X } from 'lucide-react';

/**
 * 质量报告 + 测试集管理（知识库详情页）。
 *
 * 两个按钮，对应两层指标：
 *   快速检查  → 只跑检索层（命中率/Recall），1 秒同步返回
 *   完整评测  → 检索 + 生成（引用正确率/拒答率），异步跑 + 进度条
 *
 * 完整评测必须异步：8 条约 2 分钟、50 条约 20 分钟，同步请求必然超时。
 */
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);

export default function EvalPanel({ knowledgeBaseId, initialReport, goldenCount, goldenSource, collectionKind }) {
  const router = useRouter();
  const fileRef = useRef(null);
  const timerRef = useRef(null);

  const [report, setReport] = useState(initialReport);
  const [golden, setGolden] = useState({ count: goldenCount, source: goldenSource });
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(''); // 'quick' | 'full' | 'upload'
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // 组件卸载时清掉轮询
  useEffect(() => () => clearInterval(timerRef.current), []);

  async function quickRun() {
    setBusy('quick');
    setError('');
    try {
      const res = await fetch('/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledgeBaseId, mode: 'retrieval' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '评测失败');
        return;
      }
      setReport(data.report);
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setBusy('');
    }
  }

  async function fullRun() {
    setBusy('full');
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledgeBaseId, mode: 'full' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '启动失败');
        setBusy('');
        return;
      }
      setJob(data.job || { status: 'running', progress: 0, total: 0 });
      poll();
    } catch {
      setError('网络异常，请重试');
      setBusy('');
    }
  }

  function poll() {
    clearInterval(timerRef.current);
    timerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/eval/job?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
        const data = await res.json().catch(() => ({}));
        if (data.job) setJob(data.job);

        if (data.job?.status === 'done') {
          clearInterval(timerRef.current);
          if (data.report) setReport(data.report);
          setBusy('');
          setNotice('完整评测完成');
          router.refresh();
        } else if (data.job?.status === 'failed') {
          clearInterval(timerRef.current);
          setError(data.job.error || '评测失败');
          setBusy('');
        }
      } catch {
        /* 网络抖动就继续轮询 */
      }
    }, 1500);
  }

  async function onUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy('upload');
    setError('');
    setNotice('');
    try {
      const fd = new FormData();
      fd.append('knowledgeBaseId', knowledgeBaseId);
      fd.append('file', file);
      const res = await fetch('/api/eval/golden', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '上传失败');
        return;
      }
      setGolden({ count: data.count, source: 'uploaded' });
      setNotice(`已导入 ${data.count} 条${data.errors?.length ? `，${data.errors.length} 条被跳过` : ''}`);
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function clearGoldenSet() {
    if (!window.confirm('清空这个库的测试集？之后会回落到内置示例。')) return;
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/eval/golden?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || '清空失败');
        return;
      }
      setGolden({ count: null, source: 'builtin' });
      setNotice('已清空，回落到内置示例');
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    }
  }

  const tiers = report?.tiers || {};
  const rows = Object.entries(tiers);
  const failures = (report?.results || []).filter(
    (r) => r.hitAtK === false || (r.citations === 0 && r.shouldRefuse !== true),
  );
  const isFull = report?.mode === 'full';
  const running = busy === 'full' && job?.status !== 'done';

  return (
    <section className="mt-8 rounded-lg border bg-white">
      {/* 头部：标题 + 测试集 + 操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-blue-600" />
          <h2 className="text-base font-semibold text-gray-900">质量报告</h2>
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              collectionKind === 'hybrid'
                ? 'bg-green-50 text-green-700'
                : 'bg-gray-100 text-gray-500'
            }`}
            title={
              collectionKind === 'hybrid'
                ? '该库支持向量 + 关键词双路检索'
                : '该库为旧索引（单路向量），只能纯向量检索；跑 scripts/reindex.mjs 可重建'
            }
          >
            {collectionKind === 'hybrid' ? '混合索引' : '仅向量索引'}
          </span>
          {report && (
            <span className="text-xs text-gray-400">
              {isFull ? '全链路' : '检索层'}
              {report.config?.mode ? ` · ${report.config.mode === 'hybrid' ? '混合' : '纯向量'}` : ''}
              {report.config?.mode === 'hybrid' && report.config?.rrfK
                ? ` k=${report.config.rrfK} w=${report.config.denseWeight}:${report.config.sparseWeight}`
                : ''}
              {' · '}
              {new Date(report.at).toLocaleString()}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">
            测试集 {golden.count != null ? `${golden.count} 条` : '内置示例'}
            {golden.source === 'uploaded' && (
              <span className="ml-1 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">已上传</span>
            )}
          </span>

          <input ref={fileRef} type="file" accept=".jsonl,.csv,text/csv" className="hidden" onChange={onUpload} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'upload'}
            className="flex items-center rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <Upload size={14} className="mr-1.5" />
            {busy === 'upload' ? '导入中…' : '导入测试集'}
          </button>

          <a
            href="/api/eval/golden?template=1"
            className="flex items-center rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Download size={14} className="mr-1.5" />
            模板
          </a>

          {golden.source === 'uploaded' && (
            <button
              type="button"
              onClick={clearGoldenSet}
              className="flex items-center rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-500 hover:bg-gray-50"
            >
              <X size={14} className="mr-1" />
              清空
            </button>
          )}

          <button
            type="button"
            onClick={quickRun}
            disabled={busy !== ''}
            className="flex items-center rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            title="只跑检索层，1 秒返回"
          >
            <RefreshCw size={14} className={`mr-1.5 ${busy === 'quick' ? 'animate-spin' : ''}`} />
            {busy === 'quick' ? '检查中…' : '快速检查'}
          </button>

          <button
            type="button"
            onClick={fullRun}
            disabled={busy !== ''}
            className="flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            title="检索 + 生成，含引用正确率/拒答率，耗时较长"
          >
            <Play size={14} className="mr-1.5" />
            {running ? '评测中…' : '完整评测'}
          </button>
        </div>
      </div>

      {/* 进度条 */}
      {running && (
        <div className="border-b bg-blue-50/60 px-5 py-2.5">
          <div className="flex items-center justify-between text-xs text-blue-800">
            <span>
              正在生成 {job?.progress ?? 0}/{job?.total ?? 0}
              {job?.current ? ` · ${job.current}…` : ''}
            </span>
            <span>约 {Math.max(1, Math.round(((job?.total ?? 8) - (job?.progress ?? 0)) * 0.4))} 分钟</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
            <div
              className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${job?.total ? (job.progress / job.total) * 100 : 5}%` }}
            />
          </div>
        </div>
      )}

      <div className="p-5">
        {(notice || error) && (
          <p className={`mb-3 text-sm ${error ? 'text-red-500' : 'text-green-600'}`}>{error || notice}</p>
        )}

        {!report ? (
          <p className="text-sm text-gray-500">
            还没有评测数据。「快速检查」只跑检索层（1 秒），「完整评测」会调用模型、给出引用正确率与拒答率（较慢）。
          </p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="pb-2 font-medium">档位</th>
                  <th className="pb-2 font-medium">样本</th>
                  <th className="pb-2 font-medium">命中@K</th>
                  <th className="pb-2 font-medium">Recall</th>
                  <th className="pb-2 font-medium">引用正确</th>
                  <th className="pb-2 font-medium">拒答率</th>
                  <th className="pb-2 font-medium">P0</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map(([tier, a]) => (
                  <tr key={tier}>
                    <td className="py-2 font-medium text-gray-800">{tier}</td>
                    <td className="py-2 text-gray-500">{a.n}</td>
                    <td className="py-2">{pct(a.hitAtK)}</td>
                    <td className="py-2">{pct(a.recall)}</td>
                    <td className="py-2">{pct(a.citationOk)}</td>
                    <td className="py-2">{pct(a.refusal)}</td>
                    <td className={`py-2 ${a.p0 ? 'font-medium text-red-600' : 'text-gray-400'}`}>{a.p0}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-3 text-xs text-gray-400">
              {isFull
                ? '本次为全链路评测（含生成）。'
                : '本次只跑了检索层，所以引用正确 / 拒答率显示为 —。点「完整评测」补齐这两项。'}
            </p>

            {failures.length > 0 && (
              <div className="mt-4 border-t pt-3">
                <p className="mb-1 text-xs font-medium text-gray-600">失败样本（{failures.length}）</p>
                <ul className="space-y-1">
                  {failures.slice(0, 5).map((f) => (
                    <li key={f.id} className="text-xs text-gray-500">
                      <span className="text-gray-700">[{f.id}]</span> {f.question}
                      <span className="ml-2 text-red-500">
                        {f.hitAtK === false ? '检索未命中' : f.empty ? '空回答' : '无引用'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
