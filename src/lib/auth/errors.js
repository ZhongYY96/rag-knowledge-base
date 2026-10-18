/**
 * 认证/授权层共用的小工具。
 *
 * 单独一个文件是为了避免循环依赖：
 *   session.js 需要 HttpError
 *   kbAccess.js 需要 HttpError
 *   而 kbAccess.js 又要用 database.js（数据层）
 * 把 error 抽出来后，依赖是单向的：errors ← session / kbAccess ← database。
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 把任意异常转成 Response。
 * Route Handler 的 catch 里统一调它，401/403/404 就自动带上了正确状态码，
 * 不用每个接口各写一遍 if (error.status)。
 */
export function toResponse(error, fallback = '请求失败') {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error('[api] unexpected error:', error);
  return Response.json({ error: fallback }, { status: 500 });
}
