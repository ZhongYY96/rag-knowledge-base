import Link from 'next/link';
import { PlusIcon } from 'lucide-react';
import { listKnowledgeBasesForUser } from '@/lib/database';
import { requirePageUser } from '@/lib/auth/pageGuard';
import { formatDate } from '@/lib/format';

export default async function KnowledgeBasePage() {
  // 只列「我能看到的」：自己创建的 + 被共享的
  const user = await requirePageUser('/knowledgebase');
  const knowledgebases = await listKnowledgeBasesForUser(user.id);

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">知识库</h1>
        <Link
          href="/knowledgebase/new"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center"
        >
          <PlusIcon className="mr-2" size={16} />
          新建知识库
        </Link>
      </div>

      {knowledgebases.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center">
          <h2 className="text-xl font-medium mb-2">还没有知识库</h2>
          <p className="text-gray-600 mb-4">
            创建第一个知识库，开始整理你的文档。
          </p>
          <Link
            href="/knowledgebase/new"
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg inline-flex items-center"
          >
            <PlusIcon className="mr-2" size={16} />
            新建知识库
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {knowledgebases.map((kb) => (
            <Link
              href={`/knowledgebase/${kb.id}`}
              key={kb.id}
              className="bg-white rounded-lg border p-6 hover:shadow-md transition-shadow"
            >
              <h2 className="text-xl font-semibold mb-2">{kb.name}</h2>
              <p className="text-gray-600 mb-4 line-clamp-2">
                {kb.description || '暂无描述'}
              </p>
              <div className="flex justify-between items-center text-sm text-gray-500">
                <span>{kb._count.documents} 个文档</span>
                <span>
                  创建于 {formatDate(kb.createdAt)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}