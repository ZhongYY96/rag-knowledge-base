import { requireUser } from './session';
import { requireKb } from './kbAccess';
import { redirect } from 'next/navigation';

/** 页面级鉴权：失败时跳登录/列表，而不是抛 500。不能从 Route Handler 引用。 */
export async function requirePageUser(nextPath = '/knowledgebase') {
  try {
    return await requireUser();
  } catch {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
}

export async function requirePageKb(kbId, minRole = 'viewer') {
  const user = await requirePageUser(`/knowledgebase/${kbId}`);
  try {
    return { user, ...(await requireKb(kbId, user.id, minRole)) };
  } catch (error) {
    // 404：库不存在或不是你的，不区分原因
    if (error?.status === 404) redirect('/knowledgebase?missing=1');
    // 403：有权限但级别不够
    if (error?.status === 403) redirect(`/knowledgebase/${kbId}`);
    throw error;
  }
}
