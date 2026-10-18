import { redis } from '@/lib/redis';
import { isAlive } from '@/lib/jobHeartbeat';
import {
  createChatSession,
  addChatMessage,
  getChatMessages,
  getChatSession,
  deleteChatSession,
  getChatSessionsByKnowledgeBase,
} from '@/lib/database';

/**
 * 会话与「后台生成任务」。
 *
 * 关键设计：**生成的真相在服务端**。
 *   1. 用户消息先落库（用户切页面也不会丢）
 *   2. 生成用 after() 在后台跑，不依赖请求/页面生命周期
 *   3. 任务状态写 Redis（chat:job:{sessionId}），页面回来自动看到进度或结果
 *
 * 这解决了两件事：切页面任务不停、刷新后历史还在。
 */

const jobKey = (sessionId) => `chat:job:${sessionId}`;
const JOB_TTL = 60 * 60;

const STALE_JOB_MS = 3 * 60 * 1000;

export async function getJob(sessionId) {
  const raw = await redis.get(jobKey(sessionId));
  if (!raw) return null;
  try {
    const job = JSON.parse(raw);
    // 进程被杀/请求丢失会留下永久 running 的任务：超过 3 分钟一律视为失效，
    // 否则这个会话会一直被 409 挡着，用户再也发不出消息
    const orphaned = job.status === 'running' && !(await isAlive('chat', sessionId));
    if (orphaned || (job.status === 'running' && Date.now() - Number(job.startedAt || 0) > STALE_JOB_MS)) {
      const stale = {
        ...job,
        status: 'failed',
        error: orphaned ? '服务重启导致任务中断' : '任务超时',
        finishedAt: Date.now(),
      };
      await redis.set(jobKey(sessionId), JSON.stringify(stale), 'EX', JOB_TTL);
      return stale;
    }
    return job;
  } catch {
    return null;
  }
}

export async function saveJob(sessionId, job) {
  await redis.set(jobKey(sessionId), JSON.stringify(job), 'EX', JOB_TTL);
}

export async function clearJob(sessionId) {
  await redis.del(jobKey(sessionId));
}

/** 新建会话（默认标题取首条问题，过长截断） */
export async function newSession({ knowledgeBaseId, ownerId, title }) {
  return createChatSession({
    knowledgeBaseId,
    name: title || `新会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
  });
}

export async function listSessions(kbId) {
  const rows = await getChatSessionsByKnowledgeBase(kbId);
  // 带一条任务状态，列表上可以标「生成中」
  return Promise.all(
    rows.map(async (s) => ({ ...s, job: await getJob(s.id) })),
  );
}

export async function getSessionBundle(sessionId) {
  const session = await getChatSession(sessionId);
  if (!session) return null;
  const [messages, job] = await Promise.all([getChatMessages(sessionId), getJob(sessionId)]);
  return { session, messages, job };
}

/** 会话还没起过名字时，用首条问题命名（列表里才认得出） */
export async function renameIfGeneric(sessionId, text) {
  const session = await getChatSession(sessionId);
  if (!session) return;
  const name = String(session.name || '');
  if (!/^新会话/.test(name)) return;
  const title = String(text).trim().replace(/\s+/g, ' ').slice(0, 20);
  if (title) await redis.hset(`chatsession_${sessionId}`, 'name', title);
}

export async function appendMessage(sessionId, message) {
  return addChatMessage({ ...message, chatSessionId: sessionId });
}

export async function removeSession(sessionId) {
  await clearJob(sessionId);
  await deleteChatSession(sessionId);
}
