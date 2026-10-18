'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 登录 / 注册表单（客户端组件）。
 *
 * 关键点：cookie 是 httpOnly 的，前端拿不到也不用拿；
 * 同源 fetch 会自动带 cookie，所以这里**不需要** credentials: 'include'。
 * 登录成功只要 router.push + router.refresh（后者让 Server Component 重新取数）。
 */
export default function LoginForm({ next = '/chat' }) {
  const router = useRouter();
  const [mode, setMode] = useState('login'); // login | register
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isRegister = mode === 'register';

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isRegister ? form : { email: form.email, password: form.password },
        ),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || '请求失败');
        return;
      }

      router.push(next);
      router.refresh();
    } catch {
      setError('网络异常，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <h1 className="text-xl font-semibold">{isRegister ? '注册账号' : '登录'}</h1>

      {isRegister && (
        <input
          className="w-full rounded border px-3 py-2"
          placeholder="昵称（可选）"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          maxLength={40}
        />
      )}

      <input
        className="w-full rounded border px-3 py-2"
        type="email"
        required
        placeholder="邮箱"
        autoComplete="email"
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
      />

      <input
        className="w-full rounded border px-3 py-2"
        type="password"
        required
        placeholder="密码（至少 8 位，不能是纯数字）"
        autoComplete={isRegister ? 'new-password' : 'current-password'}
        minLength={8}
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
      />

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
      >
        {loading ? '处理中…' : isRegister ? '注册并登录' : '登录'}
      </button>

      <button
        type="button"
        className="w-full text-sm text-gray-500 hover:text-gray-800"
        onClick={() => {
          setMode(isRegister ? 'login' : 'register');
          setError('');
        }}
      >
        {isRegister ? '已有账号？去登录' : '没有账号？去注册'}
      </button>
    </form>
  );
}
