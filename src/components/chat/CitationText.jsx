'use client';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCitations from './remarkCitations';

/**
 * 回答渲染：官方 Markdown 组件 + 可点击引用角标。
 *
 * 分工：
 *   · 语法解析交给 react-markdown（CommonMark）+ remark-gfm（表格/删除线/任务列表）
 *   · 引用角标由 remarkCitations 插件在 AST 里插 <cite> 节点
 *   · 渲染成 HTML 时不做 dangerouslySetInnerHTML，raw HTML 默认不解析（安全）
 *
 * 引用编号越界时故意渲染成红色删除线：静默丢弃会让人误以为引用都准。
 */
function CitationBadge({ index, sourceCount, activeIndex, onCitationClick }) {
  const valid = index <= sourceCount;
  const isActive = activeIndex === index;

  return (
    <button
      type="button"
      disabled={!valid}
      onClick={() => valid && onCitationClick?.(index)}
      title={valid ? `查看第 ${index} 条来源` : `引用了不存在的来源 [${index}]`}
      className={[
        'mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded px-1 align-super text-[11px] font-medium leading-none transition-colors',
        valid
          ? isActive
            ? 'bg-blue-600 text-white'
            : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
          : 'bg-red-50 text-red-500 line-through',
      ].join(' ')}
    >
      {index}
    </button>
  );
}

export default function CitationText({ text, sourceCount = 0, activeIndex = null, onCitationClick }) {
  const ctx = { sourceCount, activeIndex, onCitationClick };

  return (
    <div className="text-[15px] leading-7 text-gray-800">
      <Markdown
        remarkPlugins={[remarkGfm, remarkCitations]}
        components={{
          cite: ({ node }) => (
            <CitationBadge index={Number(node?.properties?.dataIndex ?? 0)} {...ctx} />
          ),
          p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
          h1: ({ children }) => <p className="mb-2 mt-3 text-lg font-semibold text-gray-900">{children}</p>,
          h2: ({ children }) => <p className="mb-2 mt-3 text-base font-semibold text-gray-900">{children}</p>,
          h3: ({ children }) => <p className="mb-1 mt-2 text-[15px] font-semibold text-gray-900">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-gray-300 pl-3 text-gray-600">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-gray-200" />,
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-lg bg-gray-900 p-3 text-[13px] leading-6 text-gray-100 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-gray-100">
              {children}
            </pre>
          ),
          code: ({ className, children }) => (
            <code className={`rounded bg-gray-100 px-1 py-0.5 font-mono text-[13px] ${className ?? ''}`}>
              {children}
            </code>
          ),
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b bg-gray-50 px-2 py-1 text-left font-medium text-gray-700">{children}</th>
          ),
          td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
