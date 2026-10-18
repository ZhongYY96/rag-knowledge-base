'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 退出按钮（客户端组件），丢到侧边栏/导航里即可。
 *
 * 调的是 POST /api/auth/logout：
 *   - 默认只清当前浏览器的 cookie
 *   - all=true 会把服务端的 sessionVer +1，**所有设备**立即下线
 *     （这也是 JWT 这种无状态方案实现「强制下线」的方式）
 */
export default function LogoutButton({ all = false, className = '' }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      await fetch(`/api/auth/logout${all ? '?all=1' : ''}`, { method: 'POST' });
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={loading}
      className={`text-sm text-gray-500 hover:text-gray-800 disabled:opacity-50 ${className}`}
      title={all ? '所有设备退出登录' : '退出登录'}
    >
      {loading ? '退出中…' : all ? '全部设备退出' : '退出登录'}
    </button>
  );
}
