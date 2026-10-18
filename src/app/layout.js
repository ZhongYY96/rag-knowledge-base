import './index.css';
import Sidebar from '@/components/Sidebar';

export const metadata = {
  title: 'RAG 知识库问答',
  description: '基于本地模型的检索增强问答系统，支持文档上传、引用溯源与原文核对。',
};

/*
 * ⛔️ 这里原本包着 <ClerkProvider>，已移除。
 *
 * 原因：认证在这个 demo 里已经不再需要（/chat 和 RAG 全都匿名可访问），
 * 而 Clerk 在未配置 key 时会走 keyless 模式 —— 自动从网络申请一个开发实例，
 * 于是每个页面右下角都挂着一个「Configure your application」徽标，
 * 同时还会加载 clerk.accounts.dev 的第三方脚本。
 *
 * 对一个主打「全本地部署、不依赖外部 API」的 RAG demo 来说，
 * 那是唯一还在回连云端的依赖 —— 删掉之后说法才自洽。
 *
 * 要恢复登录：装回 @clerk/nextjs → 在这里重新包 <ClerkProvider>
 * → 并把 src/middleware.js 换回 clerkMiddleware。
 */
export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex flex-col flex-1 ml-60 bg-muted/50">
            <main className="flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
