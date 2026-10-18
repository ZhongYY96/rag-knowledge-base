'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, ChevronDown, ExternalLink } from 'lucide-react';
import SourcePreview from './SourcePreview';

/**
 * 回答下方的「引用来源」卡片列表。
 *
 * 交互：
 *   · 点回答里的角标 → 对应卡片滚进视野并自动展开（activeIndex 由父组件控制）
 *   · 点卡片头 → 展开/收起该块的原文
 *   · 点「查看原文」→ 打开 SourcePreview，定位到原文里的位置
 */
export default function SourceList({ sources, knowledgeBaseId, activeIndex, onActiveChange }) {
  const [openIndex, setOpenIndex] = useState(null);
  const [previewSource, setPreviewSource] = useState(null);
  const itemRefs = useRef({});

  // 角标被点击时，展开对应卡片并滚进视野
  useEffect(() => {
    if (activeIndex == null) return;
    setOpenIndex(activeIndex);
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  if (!sources || sources.length === 0) {
    return (
      <p className="mt-3 text-xs text-gray-400">
        本次回答未引用任何文档内容
      </p>
    );
  }

  return (
    <div className="mt-3 border-t border-gray-200 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-gray-500">引用来源 · {sources.length}</p>
        {sources[0]?.retrievalMode === 'hybrid' && (
          <span
            className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700"
            title="语义与关键词两路召回，按排名融合"
          >
            语义 + 关键词
          </span>
        )}
        {sources[0]?.retrievalMode === 'dense' && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500" title="只看语义相似度">
            语义检索
          </span>
        )}
      </div>

      <ul className="space-y-1.5">
        {sources.map((s) => {
          const open = openIndex === s.index;
          const active = activeIndex === s.index;
          const location = s.pageNumber ? `第 ${s.pageNumber} 页` : `第 ${(s.chunkIndex ?? 0) + 1} 块`;

          return (
            <li
              key={s.index}
              ref={(el) => {
                itemRefs.current[s.index] = el;
              }}
              className={`rounded-md border text-sm transition-colors ${
                active ? 'border-blue-300 bg-blue-50/50' : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-center gap-2 px-2.5 py-2">
                {/* 序号徽标，和回答里的角标一一对应 */}
                <button
                  type="button"
                  onClick={() => onActiveChange?.(active ? null : s.index)}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-medium ${
                    active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                  title="在回答中定位"
                >
                  {s.index}
                </button>

                <FileText className="h-4 w-4 shrink-0 text-gray-400" />

                <button
                  type="button"
                  onClick={() => setOpenIndex(open ? null : s.index)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="truncate">{s.fileName}</span>
                  <span className="shrink-0 text-xs text-gray-400">{location}</span>
                  {s.retrievalMode === 'hybrid' && s.retrievalRank && (
                    <span
                      className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700"
                      title={`融合排名 #${s.retrievalRank}｜融合分 ${s.fusedScore ?? '—'}｜语义分 ${s.denseScore ?? '—'}`}
                    >
                      融合 #{s.retrievalRank}
                    </span>
                  )}
                  {s.score != null && (
                    <span
                      className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
                      title="与问题的向量相似度（阈值按这个卡）"
                    >
                      {s.score}
                    </span>
                  )}
                  <ChevronDown
                    className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
                  />
                </button>
              </div>

              {open && (
                <div className="border-t border-gray-100 px-2.5 py-2">
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-6 text-gray-700">
                    {s.content}
                  </pre>
                  <button
                    type="button"
                    onClick={() => setPreviewSource(s)}
                    className="mt-2 inline-flex items-center text-xs text-blue-600 hover:text-blue-800"
                  >
                    <ExternalLink className="mr-1 h-3 w-3" />
                    查看原文
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {previewSource && (
        <SourcePreview
          source={previewSource}
          knowledgeBaseId={knowledgeBaseId}
          onClose={() => setPreviewSource(null)}
        />
      )}
    </div>
  );
}
