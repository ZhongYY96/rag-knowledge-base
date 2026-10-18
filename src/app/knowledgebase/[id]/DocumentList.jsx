'use client';

import { useState } from 'react';
import { fileTypeLabel, formatDate, formatFileSize } from '@/lib/format';
import { useRouter } from 'next/navigation';
import { FileText, MoreHorizontal, Trash2 } from 'lucide-react';
import ActionMenu from '@/components/ui/action-menu';

export default function DocumentList({ documents, knowledgeBaseId }) {
  const router = useRouter();
  const [activeMenu, setActiveMenu] = useState(null);
  const [deleteModal, setDeleteModal] = useState({ open: false, docId: null });
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteClick = (docId) => {
    setActiveMenu(null);
    setDeleteModal({ open: true, docId });
  };

  const handleDelete = async () => {
    if (!deleteModal.docId) return;

    setIsDeleting(true);

    try {
      const response = await fetch(`/api/knowledgebase/${knowledgeBaseId}/document/${deleteModal.docId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete document');
      }

      // Close modal and refresh the page data
      setDeleteModal({ open: false, docId: null });
      router.refresh();
    } catch (error) {
      console.error('Error deleting document:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const getFileTypeIcon = (fileType) => {
    return <FileText size={16} className="text-blue-600" />;
  };

  return (
    <div className="bg-white rounded-lg border overflow-hidden mb-6">
      {documents.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 text-xs uppercase text-gray-700">
              <tr>
                <th className="px-6 py-3 text-left">文件名</th>
                <th className="px-6 py-3 text-left">类型</th>
                <th className="px-6 py-3 text-left">大小</th>
                <th className="px-6 py-3 text-left">上传时间</th>
                <th className="px-6 py-3 text-left">分块数</th>
                <th className="px-6 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {documents.map((doc) => (
                <tr key={doc.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center">
                      {getFileTypeIcon(doc.fileType)}
                      <span className="ml-2 font-medium">{doc.originalName}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {fileTypeLabel(doc.fileType)}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {formatFileSize(doc.fileSize)}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {formatDate(doc.createdAt)}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {/* 原来读的是 doc._count?.chunks，但数据库里存的字段叫 chunkCount
                        （见 lib/database.js 的 updateDocumentChunkCount）—— 所以永远显示 0。 */}
                    {doc.chunkCount ?? doc._count?.chunks ?? 0}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {/* 用 portal 菜单：普通的 absolute 菜单会被外层的
                        overflow-hidden（卡片圆角）和 overflow-x-auto（表格滚动）裁掉。 */}
                    <ActionMenu
                      open={activeMenu === doc.id}
                      onOpenChange={(open) => setActiveMenu(open ? doc.id : null)}
                      trigger={<MoreHorizontal size={16} />}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => handleDeleteClick(doc.id)}
                        className="flex items-center w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                      >
                        <Trash2 size={14} className="mr-2" />
                        删除该文档
                      </button>
                    </ActionMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* 删除文档 Modal */}
      {deleteModal.open && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6">
            <h3 className="text-xl font-bold mb-4">删除文档</h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to delete this document? This will remove the document and all its chunks from the knowledge base. This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setDeleteModal({ open: false, docId: null })}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                disabled={isDeleting}
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 flex items-center"
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
