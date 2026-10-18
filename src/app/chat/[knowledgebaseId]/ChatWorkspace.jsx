'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Plus, SendIcon, Trash2 } from 'lucide-react';
import CitationText from '@/components/chat/CitationText';
import SourceList from '@/components/chat/SourceList';
import CopyButton from '@/components/chat/CopyButton';

/**
 * 对话工作区（客户端）。
 *
 * 三条规则：
 *   1. 发消息 → 202 立刻返回，生成在服务端后台跑
 *   2. 任务在跑就轮询；页面切走再回来，轮询会从服务端状态恢复
 *   3. 历史永远以服务端为准，本地只做乐观追加
 */
export default function ChatWorkspace({
  knowledgeBaseId,
  activeSessionId,
  sessions,
  initialMessages,
  initialJob,
}) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState(activeSessionId);
  const [messages, setMessages] = useState(initialMessages || []);
  const [job, setJob] = useState(initialJob);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeCitation, setActiveCitation] = useState(null);
  const timer = useRef(null);
  const esRef = useRef(null);
  const scrollRef = useRef(null);
  // 流式增量（SSE 推来的、还没落库的部分）
  const [streamText, setStreamText] = useState('');
  // 用 ref 累积、rAF 合并刷新：每个 delta 都 setState 会让整页跟着重渲染
  const streamBuf = useRef('');
  const rafRef = useRef(null);

  const running = job?.status === 'running';

  useEffect(
    () => () => {
      clearInterval(timer.current);
      esRef.current?.close();
    },
    [],
  );

  // 新消息进来滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, running]);

  // 首屏如果任务在跑（说明是切页面回来的），直接恢复订阅
  useEffect(() => {
    if (initialJob?.status === 'running' && sessionId) startStream(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 订阅服务端的增量流（SSE）。
   *
   * ⚠️ 这和"任务"是两条独立通道：关掉 EventSource 只是不看了，
   *    服务端 after() 里的生成照跑，结果照样落库。
   *    所以切页面回来时，重新 startStream 就能从 Redis 回放已有内容。
   */
  function startStream(id) {
    esRef.current?.close();
    clearInterval(timer.current);
    streamBuf.current = '';
    setStreamText('');

    const es = new EventSource(`/api/chat/sessions/${id}/stream`);
    esRef.current = es;

    es.addEventListener('delta', (e) => {
      try {
        const { d } = JSON.parse(e.data);
        if (!d) return;
        streamBuf.current += d;
        // 一帧最多刷新一次
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          setStreamText(streamBuf.current);
        });
      } catch {
        /* 忽略坏帧 */
      }
    });

    es.addEventListener('done', async () => {
      es.close();
      esRef.current = null;

      // data 必须在 try 外声明：try 里是块级作用域，出去就 ReferenceError
      let job = null;
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages || []);
          job = data.job || null;
          setJob(job);
        }
      } catch {
        /* 拿不到就等下次刷新 */
      }

      setStreamText('');

      // 万一收到的是上一轮的 done，任务其实还在跑 —— 重新订阅而不是停在这里
      if (job?.status === 'running') {
        setTimeout(() => startStream(id), 300);
        return;
      }

      setBusy(false);
      router.refresh(); // 刷新左侧列表（会话名、时间）
    });

    // SSE 断了自己降级成轮询，别让用户卡住
    es.onerror = () => {
      es.close();
      esRef.current = null;
      poll(id);
    };
  }

  function poll(id) {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        setMessages(data.messages || []);
        setJob(data.job || null);
        if (data.job?.status !== 'running') {
          clearInterval(timer.current);
          setBusy(false);
          router.refresh(); // 让左侧会话列表标题/时间跟着更新
        }
      } catch {
        /* 网络抖动继续轮询 */
      }
    }, 1500);
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const res = await fetch('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knowledgeBaseId, title: input.trim().slice(0, 20) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '新建会话失败');
    setSessionId(data.session.id);
    window.history.replaceState(null, '', `?session=${data.session.id}`);
    return data.session.id;
  }

  async function onSend(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || running) return;

    setError('');
    setBusy(true);
    setInput('');

    // 乐观追加用户消息
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: text, sources: [] }]);
    setActiveCitation(null);

    try {
      const id = await ensureSession();
      const res = await fetch(`/api/chat/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '发送失败');
        setBusy(false);
        return;
      }
      setJob(data.job || { status: 'running' });
      startStream(id);
    } catch (err) {
      setError(err.message || '发送失败');
      setBusy(false);
    }
  }

  async function newSession() {
    setError('');
    try {
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knowledgeBaseId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '新建会话失败');
        return;
      }
      router.push(`/chat/${knowledgeBaseId}?session=${data.session.id}`);
      router.refresh();
    } catch {
      setError('网络异常');
    }
  }

  async function cancelTurn() {
    if (!sessionId) return;
    try {
      await fetch(`/api/chat/sessions/${sessionId}/cancel`, { method: 'POST' });
    } catch {
      /* 忽略 */
    }
    esRef.current?.close();
    esRef.current = null;
    clearInterval(timer.current);
    streamBuf.current = '';
    setStreamText('');
    setJob(null);
    setBusy(false);
    router.refresh();
  }

  async function removeSession(id) {
    if (!window.confirm('删除这个会话？消息记录会一起删掉。')) return;
    await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' });
    if (id === sessionId) {
      router.push(`/chat/${knowledgeBaseId}`);
    }
    router.refresh();
  }

  const activeIndexFor = (messageId) =>
    activeCitation?.messageId === messageId ? activeCitation.index : null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 会话列表 */}
      <aside className="hidden w-56 shrink-0 border-r bg-white p-3 md:block">
        <button
          type="button"
          onClick={newSession}
          className="mb-3 flex w-full items-center justify-center rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          <Plus size={14} className="mr-1" />
          新会话
        </button>

        <ul className="space-y-1">
          {sessions.length === 0 && <li className="px-2 py-1 text-xs text-gray-400">还没有会话</li>}
          {sessions.map((s) => (
            <li key={s.id} className="group flex items-center">
              <Link
                href={`/chat/${knowledgeBaseId}?session=${s.id}`}
                className={`flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1.5 text-sm ${
                  s.id === sessionId ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {s.running && <Loader2 size={12} className="shrink-0 animate-spin" />}
                <span className="truncate">
                  {!s.name || /^新会话/.test(s.name) ? '新会话' : s.name}
                </span>
              </Link>
              <button
                type="button"
                onClick={() => removeSession(s.id)}
                className="ml-1 hidden text-gray-300 hover:text-red-500 group-hover:block"
                title="删除会话"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 消息区 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            {messages.length === 0 && !running ? (
              <div className="py-16 text-center">
                <h2 className="text-lg font-medium text-gray-900">开始提问</h2>
                <p className="mt-1 text-sm text-gray-500">
                  回答会标注引用来源，可点开核对原文。生成在后台进行，切页面不会中断。
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="group flex justify-end">
                      <div className="flex flex-col items-end gap-1">
                        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-[15px] leading-7 text-white shadow-sm">
                          {m.content}
                        </div>
                        <CopyButton
                          text={m.content}
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                        />
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-medium text-white">
                        AI
                      </div>
                      <div className="group min-w-0 flex-1 rounded-2xl rounded-tl-md border border-gray-200 bg-white px-4 py-3 shadow-sm">
                        <div className="mb-1 flex justify-end">
                          <CopyButton
                            text={m.content}
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        </div>
                        <CitationText
                          text={m.content}
                          sourceCount={m.sources?.length ?? 0}
                          activeIndex={activeIndexFor(m.id)}
                          onCitationClick={(index) => setActiveCitation({ messageId: m.id, index })}
                        />
                        <SourceList
                          sources={m.sources}
                          knowledgeBaseId={knowledgeBaseId}
                          activeIndex={activeIndexFor(m.id)}
                          onActiveChange={(index) =>
                            setActiveCitation(index == null ? null : { messageId: m.id, index })
                          }
                        />
                      </div>
                    </div>
                  ),
                )}

                {running && (
                  <div className="flex gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-medium text-white">
                      AI
                    </div>
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm">
                      {streamText ? (
                        <p className="whitespace-pre-wrap break-words leading-7 text-gray-800">
                          {streamText}
                          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-blue-500 align-middle" />
                        </p>
                      ) : (
                        <span className="flex items-center gap-2 text-gray-500">
                          <Loader2 size={14} className="animate-spin text-blue-600" />
                          正在检索并生成…
                          <button
                            type="button"
                            onClick={cancelTurn}
                            className="ml-2 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-50"
                          >
                            取消
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
          </div>
        </div>

        <div className="shrink-0 border-t bg-white">
          <div className="mx-auto w-full max-w-3xl px-6 py-4">
            <form onSubmit={onSend} className="flex items-end gap-2">
              <textarea
                className="flex-1 resize-none rounded-xl border border-gray-300 px-3.5 py-2.5 text-[15px] leading-6 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                placeholder={running ? '正在生成，请稍候…' : '输入你的问题…（Enter 发送，Shift+Enter 换行）'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSend(e);
                  }
                }}
                rows={1}
                disabled={running}
              />
              <button
                type="submit"
                disabled={running || !input.trim()}
                className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                aria-label="发送"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <SendIcon size={16} />}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
