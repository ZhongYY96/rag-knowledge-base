'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Database, Home, Settings, Shield } from 'lucide-react';
import LogoutButton from './LogoutButton';

export default function Sidebar() {
  const pathname = usePathname();
  const [user, setUser] = useState(null);

  // 登录页不显示侧栏（否则未登录的人会看到一堆点了就跳登录的入口）
  const isLoginPage = pathname === '/login';

  useEffect(() => {
    if (isLoginPage) return;
    let alive = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d?.user && setUser(d.user))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isLoginPage, pathname]);

  if (isLoginPage) return null;

  const isActive = (path) => {
    if (path === '/' && pathname === '/') return true;
    if (path !== '/' && pathname.startsWith(path)) return true;
    return false;
  };

  return (
    <div className="fixed top-0 left-0 w-60 h-screen bg-white border-r flex flex-col overflow-y-auto">
      <div className="p-4 border-b">
        <Link href="/" className="flex items-center">
          <span className="ml-2 font-bold text-gray-800">RAG 知识库</span>
        </Link>
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          <li>
            <Link
              href="/"
              className={`flex items-center p-2 rounded-md ${isActive('/') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100'
                }`}
            >
              <Home size={20} className="mr-3" />
              <span>工作台</span>
            </Link>
          </li>
          <li>
            <Link
              href="/knowledgebase"
              className={`flex items-center p-2 rounded-md ${isActive('/knowledgebase') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100'
                }`}
            >
              <Database size={20} className="mr-3" />
              <span>知识库</span>
            </Link>
          </li>
          <li>
            <Link
              href="/audit"
              className={`flex items-center p-2 rounded-md ${isActive('/audit') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              <Shield size={20} className="mr-3" />
              <span>审计</span>
            </Link>
          </li>
          <li>
            <Link
              href="/settings"
              className={`flex items-center p-2 rounded-md ${isActive('/settings') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100'}`}
            >
              <Settings size={20} className="mr-3" />
              <span>设置</span>
            </Link>
          </li>
          {/*
            ⛔️ 这里原本有一个指向 /chat 的「Chat」入口，已移除。
            原因：/chat 是教程里那个通用助手（走 /api + 每日配额），跟 RAG 毫无关系。
            面试官点进来看到的是完全不同的东西，然后会问「这俩什么关系」——
            而且它和下面的 Knowledge Base 指向不同页面却会被 isActive 同时判定为激活。
            真正的 RAG 入口是：Knowledge Base → 选一个库 → Chat 按钮。
          */}
        </ul>
      </nav>

      <div className="space-y-2 border-t p-4">
        <p className="truncate text-sm text-gray-700">{user?.name || user?.email || '…'}</p>
        <p className="truncate text-xs text-gray-400">{user?.email}</p>
        <div className="flex flex-col items-start gap-1 pt-1">
          <LogoutButton />
          <LogoutButton all />
        </div>
      </div>
    </div>
  );
}
