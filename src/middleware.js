import { NextResponse } from 'next/server';

/**
 * ⚠️ middleware 不是安全边界，只是「UX 跳转层」。
 *
 * 它跑在 Edge Runtime（没有 node:crypto，验不了 JWT 签名），
 * 而且只拦页面导航 —— API Route 和 Server Action 都能被直接构造请求绕过。
 *
 * 所以这里只做一件很粗的事：**cookie 在不在**。其余判断（验签、过期、
 * 用户是否被删、kb 归属）都在页面和路由里由 requireUser()/requireKb() 完成。
 *
 * ── 2026-10：从「Claude 已移除、啥都不拦」改成「默认拒绝」──
 *
 * 上一版是：Clerk 整个移除后，middleware 只加安全头，等于全站匿名可访问
 * （这就是「为什么没有登录」的直接原因）。而且它是白名单式保护 ——
 * 每加一个新页面都要记得回来加一行，忘一次就漏一次。
 *
 * 现在反过来：除了明确公开的路径，全部要求有 cookie。
 */

const SESSION_COOKIE = 'kb_session';

/** 明确公开的页面 */
const PUBLIC_PATHS = new Set(['/login']);

/** 明确公开的 API 前缀（注册/登录本身） */
const PUBLIC_API_PREFIXES = ['/api/auth'];

const isPublic = (pathname) =>
  PUBLIC_PATHS.has(pathname) ||
  PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const applySecurityHeaders = (response) => {
  /*
   * 必须是 SAMEORIGIN，不能是 DENY。
   * 引用溯源里的「查看原文」是用自己的页面去 iframe 自己的 PDF 文件接口，
   * DENY 会把同源嵌入也拒掉，表现是预览弹窗一片空白。
   */
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
};

export default function middleware(req) {
  const { pathname } = req.nextUrl;

  // 预检请求：直接回 204
  if (req.method === 'OPTIONS') {
    const preflight = new NextResponse(null, { status: 204 });
    preflight.headers.set('Access-Control-Allow-Origin', '*');
    preflight.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    preflight.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return preflight;
  }

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  // 已登录还去 /login → 送去工作台
  if (pathname === '/login' && hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return applySecurityHeaders(NextResponse.redirect(url));
  }

  if (hasSession || isPublic(pathname)) {
    return applySecurityHeaders(NextResponse.next());
  }

  // ── 以下都是「没有 cookie 且不是公开路径」──

  // API 不跳转：路由自己回 401 JSON（跳成 HTML 前端反而看不懂）
  if (pathname.startsWith('/api') || pathname.startsWith('/trpc')) {
    return applySecurityHeaders(NextResponse.next());
  }

  // 页面：带上去向，登录后回到原处
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  const next = pathname + (req.nextUrl.search || '');
  if (next && next !== '/') url.searchParams.set('next', next);
  return applySecurityHeaders(NextResponse.redirect(url));
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
