'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, FileWarning, Download } from 'lucide-react';

/**
 * 「查看原文」弹窗。
 *
 * 分三种情况：
 *   PDF      → 浏览器内置阅读器，靠 URL 的 #page=N 跳到命中页
 *   TXT/MD   → 拉全文，把命中的那段高亮并滚过去
 *   其他     → 说明不支持预览，只给下载
 *
 * 高亮定位：切分器不会改动文本内容，所以 chunk 原文一定是原文件的子串，
 * 直接 indexOf 就能找到位置，不用额外存字符偏移。
 */

const TEXT_TYPES = new Set(['text/plain', 'text/markdown']);

export default function SourcePreview({ source, knowledgeBaseId, onClose }) {
  const fileType = source.fileType ?? '';
  const isPdf = fileType === 'application/pdf';
  const isText = TEXT_TYPES.has(fileType);

  /**
   * 知识库归属优先取「这条引用自己带的」。
   *
   * 为什么不直接依赖页面传来的 knowledgeBaseId：
   *   <AI> provider 挂在 app/chat/layout.js 上，useUIState 里的消息在
   *   所有 /chat/* 页面之间共享 —— 消息可能来自 A 库，而地址栏已经是 B 库。
   *   这时用页面的 id 去取文件会被归属校验拦成 403，
   *   而弹窗里只会显示一段 JSON 错误（用户看不懂）。
   *
   * 让每条引用自带归属，弹窗就能在任何页面上正确工作。
   * 页面传来的值只作为旧消息的兜底。
   */
  const kbId = source.knowledgeBaseId || knowledgeBaseId;

  const fileUrl = kbId
    ? `/api/knowledgebase/${encodeURIComponent(kbId)}/document/${encodeURIComponent(source.documentId)}/file`
    : null;

  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [frameReady, setFrameReady] = useState(false);
  const hitRef = useRef(null);

  /**
   * 预检 + 取内容。
   *
   * PDF 也要预检：如果把 URL 直接交给 iframe，一旦接口返回 403/404，
   * 浏览器会把那段 JSON **当成文档**渲染在 iframe 里 ——
   * 用户看到的就是一串 {"error":"..."}，完全不知道发生了什么。
   * 先自己请求一次确认可访问，再渲染 iframe。
   *
   * 响应带了 Cache-Control，iframe 那次会命中缓存，不会重复下载。
   */
  useEffect(() => {
    if (!fileUrl) {
      setError('这条引用缺少知识库信息，无法定位原文件');
      return;
    }

    let cancelled = false;
    setText(null);
    setError(null);
    setFrameReady(false);

    fetch(fileUrl)
      .then(async (res) => {
        if (!res.ok) {
          // 后端返回的是 { error: '...' }，取出来直接给用户看
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `读取失败（HTTP ${res.status}）`);
        }
        // PDF 不需要正文，读成 blob 只是为了让请求完整结束、结果能被缓存
        return isText ? res.text() : res.blob();
      })
      .then((payload) => {
        if (cancelled) return;
        if (isText) setText(payload);
        else setFrameReady(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [fileUrl, isText]);

  // 把全文切成「前段 / 命中段 / 后段」，命中段单独包一层高亮
  const pieces = useMemo(() => {
    if (!text) return null;
    const needle = (source.content ?? '').trim();
    if (!needle) return null;

    let at = text.indexOf(needle);
    let len = needle.length;

    if (at < 0) {
      // 兜底：用前缀找
      const probe = needle.slice(0, 60);
      at = text.indexOf(probe);
      len = probe.length;
    }
    if (at < 0) return null; // 真找不到就不高亮，全文照常显示

    return {
      before: text.slice(0, at),
      hit: text.slice(at, at + len),
      after: text.slice(at + len),
    };
  }, [text, source.content]);

  // 拉完就把高亮段滚进视野
  useEffect(() => {
    if (pieces && hitRef.current) {
      hitRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [pieces]);

  // Esc 关闭
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const location = source.pageNumber ? `第 ${source.pageNumber} 页` : `第 ${(source.chunkIndex ?? 0) + 1} 块`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{source.fileName}</p>
            <p className="text-xs text-gray-500">
              定位：{location}
              {source.score != null && ` · 相似度 ${source.score}`}
            </p>
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-2">
            {/* 出错时不给下载入口，因为下载下来也是那段 JSON */}
            {fileUrl && !error && (
              <a
                href={fileUrl}
                download={source.fileName}
                className="flex items-center rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Download className="mr-1 h-4 w-4" />
                下载
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
              aria-label="关闭"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 内容区 */}
        <div className="min-h-0 flex-1 bg-gray-50">
          {/* 错误优先，三种格式统一走这里 */}
          {error && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileWarning className="h-10 w-10 text-red-400" />
              <p className="font-medium text-red-700">{error}</p>
              <p className="max-w-md text-sm leading-6 text-gray-500">
                常见原因：原文件已从 uploads/ 目录移除（需要重新上传），或者这条引用来自另一个知识库。
              </p>
            </div>
          )}

          {!error && (isText || isPdf) && !frameReady && !text && (
            <div className="flex h-full items-center justify-center text-gray-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              正在读取原文…
            </div>
          )}

          {!error && isPdf && frameReady && (
            // 浏览器内置 PDF 阅读器，#page=N 直接跳到命中页
            <iframe
              src={`${fileUrl}#page=${source.pageNumber ?? 1}&toolbar=1`}
              title={source.fileName}
              className="h-full w-full border-0"
            />
          )}

          {!error && isText && text && (
            <div className="h-full overflow-auto p-6">
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
                {pieces ? (
                  <>
                    {pieces.before}
                    <mark ref={hitRef} className="rounded bg-yellow-200 px-0.5">
                      {pieces.hit}
                    </mark>
                    {pieces.after}
                  </>
                ) : (
                  // 定位失败也要能看到全文，别让用户对着空白
                  text
                )}
              </pre>
            </div>
          )}

          {!error && !isPdf && !isText && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-gray-600">
              <FileWarning className="h-10 w-10 text-gray-400" />
              <p className="font-medium">该格式暂不支持在线预览</p>
              <p className="max-w-sm text-sm leading-6 text-gray-500">
                {fileType || '未知类型'}（例如 DOCX 是 zip 二进制包，没法直接渲染）。可以下载后用本地软件打开。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
