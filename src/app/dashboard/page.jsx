import Link from 'next/link';
import { PlusIcon, Database, Upload, MessageSquare, Info } from 'lucide-react';
import { listKnowledgeBasesForUser, getChatSessionCount } from '@/lib/database';
import { requirePageUser } from '@/lib/auth/pageGuard';

export default async function Dashboard() {
  /*
   * 鉴权 + 只读自己的数据。
   * 改造前这里是 getAllKnowledgeBases() / getAllChatSessions()：
   * 全站数据、且不校验登录 —— 匿名用户能看到所有人的库（这就是
   * 「为什么没有登录」的现场）。
   */
  const user = await requirePageUser('/dashboard');
  const knowledgebases = await listKnowledgeBasesForUser(user.id);
  const sessionCount = await getChatSessionCount(user.id);

  /*
   * 「上传文档」卡片的跳转目标。
   *
   * 教程原代码把它写死成一个不含知识库 ID 的地址，而那个路由并不存在，
   * 点下去直接 404。上传必须带知识库 ID，所以这里按情况分流：
   *   没有知识库 → 先去新建
   *   只有一个   → 直接进它的上传页（少点一次）
   *   有多个     → 先去列表挑一个
   */
  const uploadHref =
    knowledgebases.length === 0
      ? '/knowledgebase/new'
      : knowledgebases.length === 1
        ? `/knowledgebase/${knowledgebases[0].id}/upload`
        : '/knowledgebase';
  
  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header Section */}
        <div className="bg-gray-50 rounded-lg p-6 mb-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center">
            <div className="mb-4 md:mb-0">
              <h1 className="text-2xl font-bold text-blue-600 mb-2">知识库问答助手</h1>
              <p className="text-gray-600 text-sm">
                你的本地知识库与文档问答工作台。
              </p>
            </div>
            <Link 
              href="/knowledgebase/new"
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-md flex items-center text-sm"
            >
              <PlusIcon className="mr-1" size={16} />
              新建知识库
            </Link>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center">
              <div className="bg-blue-100 p-2 rounded-full">
                <Database className="text-blue-600" size={20} />
              </div>
              <div className="ml-3">
                <h2 className="text-2xl font-bold">{knowledgebases.length}</h2>
                <p className="text-gray-600 text-sm">知识库</p>
              </div>
              <div className="ml-auto">
                <Link href="/knowledgebase" className="text-blue-600 hover:text-blue-800 flex items-center text-sm">
                  查看全部
                  <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border p-4">
            <div className="flex items-center">
              <div className="bg-blue-100 p-2 rounded-full">
                <MessageSquare className="text-blue-600" size={20} />
              </div>
              <div className="ml-3">
                <h2 className="text-2xl font-bold">{sessionCount}</h2>
                <p className="text-gray-600 text-sm">对话记录</p>
              </div>
              <div className="ml-auto">
                <Link href="/knowledgebase" className="text-blue-600 hover:text-blue-800 flex items-center text-sm">
                  查看全部
                  <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </div>
          </div>
        </div>
        <h2 className="text-lg font-bold mb-3">快捷操作</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          <Link href="/knowledgebase/new" className="bg-white rounded-lg border p-4 hover:shadow-md transition-shadow">
            <div className="flex flex-col items-center text-center">
              <div className="bg-blue-100 p-3 rounded-full mb-2">
                <Database className="text-blue-600" size={20} />
              </div>
              <h3 className="font-semibold mb-1 text-sm">新建知识库</h3>
              <p className="text-gray-600 text-xs">
                创建一个新的知识库
              </p>
            </div>
          </Link>

          <Link href={uploadHref} className="bg-white rounded-lg border p-4 hover:shadow-md transition-shadow">
            <div className="flex flex-col items-center text-center">
              <div className="bg-blue-100 p-3 rounded-full mb-2">
                <Upload className="text-blue-600" size={20} />
              </div>
              <h3 className="font-semibold mb-1 text-sm">上传文档</h3>
              <p className="text-gray-600 text-xs">
                支持 PDF、MD、TXT 格式
              </p>
            </div>
          </Link>

          <Link href="/knowledgebase" className="bg-white rounded-lg border p-4 hover:shadow-md transition-shadow">
            <div className="flex flex-col items-center text-center">
              <div className="bg-blue-100 p-3 rounded-full mb-2">
                <MessageSquare className="text-blue-600" size={20} />
              </div>
              <h3 className="font-semibold mb-1 text-sm">开始问答</h3>
              <p className="text-gray-600 text-xs">
                基于知识库文档提问，并核对引用来源
              </p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}