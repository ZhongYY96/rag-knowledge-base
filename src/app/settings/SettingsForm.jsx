'use client';

import { useState } from 'react';

/**
 * 设置页主表单：对话模型 / 向量模型 / 检索与分块 三张卡，**一个保存按钮**。
 *
 * 约定：
 *   - API Key 只显示掩码；留空 = 不修改
 *   - 「测试连接」用已保存的配置（先保存再测）
 */

const PRESETS = [
  { label: '本地 llama.cpp', chatBaseUrl: 'http://127.0.0.1:8000/v1', chatModel: 'MiniCPM5-2B' },
  { label: 'DeepSeek', chatBaseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat' },
  { label: '通义千问', chatBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModel: 'qwen-plus' },
  { label: 'OpenAI', chatBaseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini' },
];

const inputCls =
  'mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

function Card({ title, desc, children }) {
  return (
    <section className="rounded-lg border bg-white p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {desc && <p className="mt-0.5 text-xs text-gray-400">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

export default function SettingsForm({ initial }) {
  const [form, setForm] = useState({
    // 对话
    chatBaseUrl: initial.chatBaseUrl,
    chatApiKey: '',
    chatModel: initial.chatModel,
    chatTemperature: initial.chatTemperature,
    chatMaxTokens: initial.chatMaxTokens,
    // 向量
    embBaseUrl: initial.embBaseUrl,
    embApiKey: '',
    embModel: initial.embModel,
    embVectorSize: initial.embVectorSize,
    // 检索与分块
    ragTopK: initial.ragTopK,
    ragScoreThreshold: initial.ragScoreThreshold,
    ragChunkSize: initial.ragChunkSize,
    ragChunkOverlap: initial.ragChunkOverlap,
    // 混合检索策略
    ragMode: initial.ragMode ?? 'hybrid',
    ragFusion: initial.ragFusion ?? 'rrf',
    ragRrfK: initial.ragRrfK ?? 60,
    ragDenseWeight: initial.ragDenseWeight ?? 0.7,
    ragSparseWeight: initial.ragSparseWeight ?? 0.3,
    ragCandidateMultiplier: initial.ragCandidateMultiplier ?? 4,
  });

  const [masked, setMasked] = useState({
    chatApiKey: initial.chatApiKey,
    embApiKey: initial.embApiKey,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState({ chat: null, embedding: null });
  const [testing, setTesting] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSave(e) {
    e.preventDefault();
    setError('');
    setSaved('');
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '保存失败');
        return;
      }
      setMasked({ chatApiKey: data.chatApiKey, embApiKey: data.embApiKey });
      setForm((f) => ({ ...f, chatApiKey: '', embApiKey: '' }));
      setSaved('已保存');
      setTimeout(() => setSaved(''), 2500);
    } catch {
      setError('网络异常，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function runTest(kind) {
    setTesting(kind);
    setTest((t) => ({ ...t, [kind]: null }));
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: '返回异常' }));
      setTest((t) => ({ ...t, [kind]: data }));
    } catch {
      setTest((t) => ({ ...t, [kind]: { ok: false, error: '网络异常' } }));
    } finally {
      setTesting('');
    }
  }

  const applyPreset = (p) =>
    setForm((f) => ({ ...f, chatBaseUrl: p.chatBaseUrl, chatModel: p.chatModel }));

  return (
    <>
      <form onSubmit={onSave} className="mt-6 space-y-4">
        <Card title="对话模型">
          <div className="mb-4 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Base URL">
              <input className={inputCls} value={form.chatBaseUrl} onChange={set('chatBaseUrl')} />
            </Field>
            <Field label="模型名">
              <input className={inputCls} value={form.chatModel} onChange={set('chatModel')} />
            </Field>
            <Field label="API Key">
              <input
                className={inputCls}
                type="password"
                value={form.chatApiKey}
                onChange={set('chatApiKey')}
                placeholder="sk-..."
                autoComplete="off"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="temperature">
                <input className={inputCls} type="number" step="0.1" min="0" max="2" value={form.chatTemperature} onChange={set('chatTemperature')} />
              </Field>
              <Field label="maxTokens">
                <input className={inputCls} type="number" min="16" max="32768" value={form.chatMaxTokens} onChange={set('chatMaxTokens')} />
              </Field>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => runTest('chat')}
              disabled={testing === 'chat'}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testing === 'chat' ? '测试中…' : '测试连接'}
            </button>
            <TestResult result={test.chat} />
          </div>
        </Card>

        <Card title="向量模型（Embedding）" desc="只影响新建的知识库，已有知识库沿用上传时的模型">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Base URL">
              <input className={inputCls} value={form.embBaseUrl} onChange={set('embBaseUrl')} />
            </Field>
            <Field label="模型名">
              <input className={inputCls} value={form.embModel} onChange={set('embModel')} />
            </Field>
            <Field label="API Key">
              <input
                className={inputCls}
                type="password"
                value={form.embApiKey}
                onChange={set('embApiKey')}
                placeholder="sk-..."
                autoComplete="off"
              />
            </Field>
            <Field label="向量维度" hint="须与模型输出一致">
              <input className={inputCls} type="number" min="32" max="8192" value={form.embVectorSize} onChange={set('embVectorSize')} />
            </Field>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => runTest('embedding')}
              disabled={testing === 'embedding'}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testing === 'embedding' ? '测试中…' : '测试连接'}
            </button>
            <TestResult result={test.embedding} />
          </div>
        </Card>

        <Card title="检索与分块" desc="检索参数即时生效；分块参数只影响新上传的文档">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Field label="召回条数">
              <input className={inputCls} type="number" min="1" max="20" value={form.ragTopK} onChange={set('ragTopK')} />
            </Field>
            <Field label="相似度阈值">
              <input className={inputCls} type="number" step="0.05" min="0" max="1" value={form.ragScoreThreshold} onChange={set('ragScoreThreshold')} />
            </Field>
            <Field label="块大小">
              <input className={inputCls} type="number" min="120" max="2000" value={form.ragChunkSize} onChange={set('ragChunkSize')} />
            </Field>
            <Field label="块重叠">
              <input className={inputCls} type="number" min="0" max="500" value={form.ragChunkOverlap} onChange={set('ragChunkOverlap')} />
            </Field>
          </div>

          <div className="mt-4 border-t pt-4">
            <p className="mb-2 text-xs font-medium text-gray-600">检索策略</p>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Field label="检索方式">
                <select className={inputCls} value={form.ragMode} onChange={set('ragMode')}>
                  <option value="dense">语义检索（当前默认）</option>
                  <option value="hybrid">语义 + 关键词</option>
                </select>
              </Field>
              <Field label="结果合并">
                <select className={inputCls} value={form.ragFusion} onChange={set('ragFusion')}>
                  <option value="rrf">按排名（RRF，推荐）</option>
                  <option value="dbsf">按分数（DBSF）</option>
                </select>
              </Field>
              <Field label="排名平滑度">
                <input className={inputCls} type="number" min="1" max="100" value={form.ragRrfK} onChange={set('ragRrfK')} />
              </Field>
              <Field label="每路候选倍数">
                <input className={inputCls} type="number" min="2" max="10" value={form.ragCandidateMultiplier} onChange={set('ragCandidateMultiplier')} />
              </Field>
              <Field label="语义权重">
                <input className={inputCls} type="number" step="0.1" min="0" max="1" value={form.ragDenseWeight} onChange={set('ragDenseWeight')} />
              </Field>
              <Field label="关键词权重">
                <input className={inputCls} type="number" step="0.1" min="0" max="1" value={form.ragSparseWeight} onChange={set('ragSparseWeight')} />
              </Field>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              当前语料下语义检索更稳（命中 100% vs 87.5%）；文档变多后再用评测决定要不要开关键词。
            </p>
          </div>
        </Card>

        {/* 唯一的保存按钮：所有配置一次提交 */}
        <div className="flex items-center justify-end gap-3 pt-1">
          {error && <span className="text-sm text-red-500">{error}</span>}
          {saved && <span className="text-sm text-green-600">{saved}</span>}
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </form>
    </>
  );
}

function TestResult({ result }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <span className="text-sm text-green-600">
        通过 · {result.latencyMs}ms {result.message ? `· ${result.message}` : ''}
        {result.warning && <span className="ml-2 text-amber-600">{result.warning}</span>}
      </span>
    );
  }
  return (
    <span className="text-sm text-red-500" title={result.detail || ''}>
      失败{result.error ? ` · ${result.error}` : ''}
      {result.detail ? ` · ${String(result.detail).slice(0, 80)}` : ''}
    </span>
  );
}
