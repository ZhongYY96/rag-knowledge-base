import Link from 'next/link';
import { formatDate } from '@/lib/format';
import { 
  ChevronLeft, 
  FileText, 
  MessageSquare, 
  Upload, 
  } from 'lucide-react';
import { getDocumentsByKnowledgeBase } from '@/lib/database';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';
import DeleteButton from './DeleteButton';
import DocumentList from './DocumentList';
import EvalPanel from './EvalPanel';
import { latestReport, loadGolden } from '@/lib/rag/eval';
import { getGolden } from '@/lib/rag/goldenStore';
import { getCollectionKind } from '@/lib/vectorStore';

export default async function KnowledgeBasePage({ params }) {
  const { id } = await params;
  const fullId = decodeURIComponent(id);

  // 鉴权：未登录 401；不是自己的库 → requireKb 抛 404 → 走下面的「不存在」
  const user = await requireUser();
  const access = await requireKb(fullId, user.id, 'viewer').catch(() => null);
  const knowledgeBase = access?.kb || null;
  if (!knowledgeBase) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <div className="bg-red-100 text-red-800 p-4 rounded-lg">
          <h2 className="text-lg font-semibold">知识库不存在</h2>
          <p>请求的知识库不存在，或已被删除。</p>
          <Link href="/knowledgebase" className="text-blue-600 hover:underline mt-2 inline-block">
            返回知识库列表
          </Link>
        </div>
      </div>
    );
  }
  
  const documents = await getDocumentsByKnowledgeBase(fullId);
  const formattedDate = formatDate(knowledgeBase.createdAt);
  // 该库最近一份评测报告（没有则渲染空态）
  const evalReport = await latestReport(fullId);
  // 当前生效的测试集：优先上传的，否则内置示例
  const uploadedGolden = await getGolden(fullId);
  const goldenCount = uploadedGolden ? uploadedGolden.length : (await loadGolden()).length;
  const goldenSource = uploadedGolden ? 'uploaded' : 'builtin';
  // 这个库的索引形态：hybrid（dense+sparse）还是 legacy（单路向量）
  const collectionKind = await getCollectionKind(fullId);
  
  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Breadcrumb navigation */}
      <nav className="mb-6">
        <Link href="/knowledgebase" className="text-blue-600 hover:text-blue-800 flex items-center text-sm">
          <ChevronLeft size={16} className="mr-1" />
          返回知识库列表
        </Link>
      </nav>
      
      {/* Knowledge Base Header */}
      <div className="bg-white rounded-lg border mb-6">
        <div className="p-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold mb-2">{knowledgeBase.name}</h1>
              <p className="text-gray-600 mb-3">
                {knowledgeBase.description || "No description provided"}
              </p>
              <p className="text-sm text-gray-500">创建于 {formattedDate}</p>
            </div>
            
            <div className="flex space-x-2">
              {/*
                ⛔️ 这里原来有一个「编辑」按钮，指向 /knowledgebase/<id>/edit，
                但项目里并没有这条路由，点了就 404 —— 所以先移除。

                后端其实已经有 updateKnowledgeBase() 了（src/lib/database.js），
                要恢复这个功能只需两步：
                  1. 在本目录加 edit/page.jsx（复用 new/page.jsx 的表单）
                  2. 在 api/knowledgebase/[knowledgebaseId]/route.js 加 PATCH 处理器
              */}
              <DeleteButton knowledgeBaseId={id} />
            </div>
          </div>
        </div>
        
        {/* Action Buttons */}
        <div className="border-t px-6 py-4 bg-gray-50 flex flex-wrap gap-3">
          <Link 
            href={`/knowledgebase/${id}/upload`}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-md flex items-center text-sm"
          >
            <Upload size={16} className="mr-1" />
            上传文档
          </Link>
          
          <Link 
            href={`/chat/${id}`}
            className="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-md flex items-center text-sm"
          >
            <MessageSquare size={16} className="mr-1" />
            开始问答
          </Link>
        </div>
      </div>
      
      {/* Documents Section */}
      <h2 className="text-xl font-bold mb-4 flex items-center">
        <FileText className="mr-2" size={20} />
        文档（{documents.length}）
      </h2>
      
      <DocumentList documents={documents} knowledgeBaseId={id} />

      <EvalPanel
        knowledgeBaseId={id}
        initialReport={evalReport}
        goldenCount={goldenCount}
        goldenSource={goldenSource}
        collectionKind={collectionKind}
      />
      
      {/* No Documents State */}
      {documents.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <div className="bg-gray-100 inline-flex rounded-full p-3 mb-4">
            <FileText size={24} className="text-gray-500" />
          </div>
          <h3 className="text-lg font-medium mb-2">还没有文档</h3>
          <p className="text-gray-600 mb-6">
            上传文档后即可构建知识库，并基于文档内容提问。
          </p>
          <Link 
            href={`/knowledgebase/${id}/upload`}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md inline-flex items-center"
          >
            <Upload size={16} className="mr-2" />
            上传文档
          </Link>
        </div>
      )}
    </div>
  );
}