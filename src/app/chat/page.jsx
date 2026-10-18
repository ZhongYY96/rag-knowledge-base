import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Database, PlusIcon } from 'lucide-react';
import { requirePageUser } from '@/lib/auth/pageGuard';
import { listKnowledgeBasesForUser } from '@/lib/database';

/**
 * /chat：选一个知识库开始问答。
 *
 * 这个路由原来是教程带的「通用助手」（走 /api，不检索任何文档），
 * 界面风格也和知识库/工作台两页完全不同，所以改成一个入口页：
 *   - 只有一个库 → 直接进 /chat/<id>
 *   - 多个库     → 列出来让你挑
 *   - 一个都没有 → 引导去新建
 *
 * 真正的对话界面在 /chat/[knowledgebaseId]，那边已经按同一套设计语言排过版。
 */

const ROLE = {
  owner: { text: '拥有者', cls: 'bg-blue-50 text-blue-700' },
  editor: { text: '可编辑', cls: 'bg-green-50 text-green-700' },
  viewer: { text: '只读', cls: 'bg-gray-100 text-gray-600' },
};

export default async function ChatIndexPage() {
  const user = await requirePageUser('/chat');
  const knowledgebases = await listKnowledgeBasesForUser(user.id);

  // 只有一个库时没必要多一次点击
  if (knowledgebases.length === 1) {
    redirect(`/chat/${knowledgebases[0].id}`);
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-blue-600">知识库问答</h1>
            <p className="mt-1 text-sm text-gray-600">
              选一个知识库开始提问，回答会标注引用来源，可点开核对原文。
            </p>
          </div>
          {knowledgebases.length > 0 && (
            <Link
              href="/knowledgebase/new"
              className="flex items-center rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
            >
              <PlusIcon size={16} className="mr-1" />
              新建知识库
            </Link>
          )}
        </div>

        {knowledgebases.length === 0 ? (
          <div className="rounded-lg border bg-white p-8 text-center">
            <h2 className="mb-2 text-xl font-medium">还没有可以提问的知识库</h2>
            <p className="mb-4 text-gray-600">先建一个知识库、上传几份文档，就能开始问答了。</p>
            <Link
              href="/knowledgebase/new"
              className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            >
              <PlusIcon size={16} className="mr-2" />
              新建知识库
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {knowledgebases.map((kb) => {
              const role = ROLE[kb.role] || ROLE.viewer;
              return (
                <Link
                  key={kb.id}
                  href={`/chat/${kb.id}`}
                  className="flex items-center justify-between rounded-lg border bg-white p-5 transition-shadow hover:shadow-md"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Database size={16} className="shrink-0 text-blue-600" />
                      <span className="truncate text-lg font-semibold text-gray-900">{kb.name}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${role.cls}`}>
                        {role.text}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-sm text-gray-500">
                      {kb.description || '暂无描述'}
                    </p>
                  </div>
                  <div className="ml-4 flex shrink-0 items-center gap-3 text-sm text-gray-500">
                    <span>{kb._count?.documents ?? 0} 个文档</span>
                    <ArrowRight size={16} className="text-gray-400" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
