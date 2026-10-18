import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requirePageKb } from '@/lib/auth/pageGuard';
import { listSessions, getSessionBundle } from '@/lib/chatSessions';
import ChatWorkspace from './ChatWorkspace';

export const dynamic = 'force-dynamic';

/**
 * 对话页（服务端组件）。
 *
 * 真相在服务端：会话、消息、生成任务状态全部来自 Redis。
 * 页面只负责把首屏数据交给客户端组件，后续靠轮询同步。
 * 所以浏览器切页面/刷新都不会丢正在跑的任务。
 */
export default async function ChatPage({ params, searchParams }) {
  const { knowledgebaseId } = await params;
  const kbId = decodeURIComponent(knowledgebaseId);
  const sp = (await searchParams) || {};
  const requested = typeof sp.session === 'string' ? sp.session : '';

  const { user, kb, role } = await requirePageKb(kbId, 'viewer');
  const sessions = await listSessions(kbId);

  // 没指定就用最近一个会话（列表已按更新时间倒序）
  const activeId = requested || sessions[0]?.id || null;
  const bundle = activeId ? await getSessionBundle(activeId) : null;

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col">
      <header className="shrink-0 border-b bg-white">
        <div className="mx-auto w-full max-w-6xl px-6 py-4">
          <Link href="/knowledgebase" className="inline-flex items-center text-xs text-gray-400 hover:text-blue-600">
            <ChevronLeft size={14} className="mr-0.5" />
            返回知识库
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-gray-900">{kb.name}</h1>
            <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">本地模型</span>
            <span className="text-xs text-gray-400">{sessions.length} 个会话</span>
          </div>
        </div>
      </header>

      <ChatWorkspace
        // ★ key 变化会让组件重新挂载：切换会话时 useState 才会用新的 initialXxx
        //   没有这个 key，路由变了但 state 还是上一个会话的，看起来就是"点了没反应"
        key={activeId ?? 'no-session'}
        knowledgeBaseId={kbId}
        activeSessionId={activeId}
        sessions={sessions.map((s) => ({
          id: s.id,
          name: s.name,
          updatedAt: s.updatedAt,
          running: s.job?.status === 'running',
        }))}
        initialMessages={bundle?.messages ?? []}
        initialJob={bundle?.job ?? null}
      />
    </div>
  );
}
