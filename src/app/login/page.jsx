import LoginForm from './LoginForm';

/**
 * 登录页（Server Component）。
 *
 * 这里**不需要**再调 requireUser()：
 * middleware 已经把「有 cookie 还来 /login」的人送回 /chat 了。
 * 但记住 middleware 只是 UX —— 如果以后把这个页面挪到别的路径，
 * 要自己在这里补 requireUser()。
 */

// 只允许站内相对路径，防止 ?next=https://evil.com 变成开放重定向
function safeNext(raw) {
  if (!raw || typeof raw !== 'string') return '/chat';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/chat';
  return raw;
}

export default async function LoginPage({ searchParams }) {
  // Next 14 是对象、15 是 Promise；await 两边都对
  const sp = (await searchParams) || {};
  const next = safeNext(Array.isArray(sp.next) ? sp.next[0] : sp.next);

  return (
    <main className="fixed inset-0 z-10 flex min-h-screen items-center justify-center bg-gray-50 p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-xl bg-white p-8 shadow">
        <LoginForm next={next} />
        <p className="text-center text-xs text-gray-400">
          登录后你只能看到自己创建或被共享的知识库
        </p>
      </div>
    </main>
  );
}
