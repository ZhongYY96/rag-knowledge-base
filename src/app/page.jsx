'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 首页只是个跳板，进来看一眼就送去 /dashboard。
 *
 * 原来这里用 Clerk 的 useUser() 判断登录态，但 if / else 两个分支
 * 都是 router.push('/dashboard') —— 判断本身是改造过程中留下的死代码。
 * 移除 Clerk 时顺手简化掉。
 */
export default function IndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.push('/dashboard');
  }, [router]);

  return <div>加载中…</div>;
}
