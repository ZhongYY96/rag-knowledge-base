import fs from 'fs/promises';
import path from 'path';
import { redis, isMissingHash } from './redis';

export function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ───────────────────────── Knowledge Base ─────────────────────────

/**
 * 角色权重。owner 存在 kb.ownerId 字段上，**不写进成员表**——
 * 否则一次误操作把 owner 降级成 viewer，这个库就再也没人能管了（自锁）。
 */
export const ROLE = { viewer: 1, editor: 2, owner: 3 };

export const kbKey = (id) => `knowledgebase_${id}`;
export const kbMembersKey = (id) => `knowledgebase_${id}:members`;
export const userKbsKey = (userId) => `user:${userId}:kbs`;

/**
 * 建库。**ownerId 是必填参数**。
 * 旧签名 createKnowledgeBase({ name, description }) 不带 owner，
 * 于是所有库都是「公共库」，列表页 smembers('knowledgebases') 全量返回。
 */
export async function createKnowledgeBase({ name, description = '', ownerId }) {
  if (!ownerId) throw new Error('createKnowledgeBase 必须传 ownerId');
  if (!name || !name.trim()) throw new Error('知识库名称必填');

  const id = generateId('kb');
  const kb = {
    id,
    name: name.trim(),
    description,
    ownerId,              // ← 权限判断的唯一依据
    visibility: 'private', // 默认私有
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await redis
    .multi()
    .hset(kbKey(id), kb)
    .sadd('knowledgebases', id)   // 全局集合只给运维/迁移脚本用
    .sadd(userKbsKey(ownerId), id) // 反查索引：我能看到哪些库
    .exec();

  return { ...kb, role: 'owner' };
}

export async function getKnowledgeBase(id) {
  const kb = await redis.hgetall(kbKey(id));
  return isMissingHash(kb) ? null : kb;
}

/**
 * 列表页唯一正确的取数方式：只查「我能看到的」。
 * 取代原来的 getAllKnowledgeBases()（不带 userId，是全站共享的根因）。
 */
export async function listKnowledgeBasesForUser(userId) {
  const ids = await redis.smembers(userKbsKey(userId));
  if (!ids || ids.length === 0) return [];

  const rows = await Promise.all(
    ids.map(async (id) => {
      const kb = await redis.hgetall(kbKey(id));
      if (isMissingHash(kb)) return null; // 库已删、索引残留

      const role = kb.ownerId === userId ? 'owner' : await redis.hget(kbMembersKey(id), userId);
      if (!role) return null;

      const documentCount = await redis.scard(`${id}_documents`);
      return { ...kb, role, _count: { documents: documentCount || 0 } };
    }),
  );

  return rows.filter(Boolean).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

/** 取某人在某库的角色；无权限返回 null */
export async function getKbRole(kbId, userId, preloadedKb) {
  const kb = preloadedKb || (await redis.hgetall(kbKey(kbId)));
  if (isMissingHash(kb)) return null;
  if (kb.ownerId === userId) return 'owner';
  const role = await redis.hget(kbMembersKey(kbId), userId);
  return role === 'editor' || role === 'viewer' ? role : null;
}

/** 加成员：同时补对方反查索引，否则他列表里看不到这个库 */
export async function addKbMember(kbId, userId, role = 'viewer') {
  if (!['editor', 'viewer'].includes(role)) throw new Error('角色只能是 editor 或 viewer');
  await redis.multi().hset(kbMembersKey(kbId), userId, role).sadd(userKbsKey(userId), kbId).exec();
}

/** 移成员：同时清反查索引 */
export async function removeKbMember(kbId, userId) {
  await redis.multi().hdel(kbMembersKey(kbId), userId).srem(userKbsKey(userId), kbId).exec();
}

/** 成员列表（含 owner，带昵称/邮箱，不含任何密码字段） */
export async function getKbMembers(kbId) {
  const kb = await redis.hgetall(kbKey(kbId));
  if (isMissingHash(kb)) return [];

  const members = await redis.hgetall(kbMembersKey(kbId));
  const rows = Object.entries(members || {}).map(([userId, role]) => ({ userId, role }));
  if (kb.ownerId) rows.unshift({ userId: kb.ownerId, role: 'owner' });

  return Promise.all(
    rows.map(async (row) => {
      const u = await redis.hgetall(`user:${row.userId}`);
      return {
        ...row,
        name: isMissingHash(u) ? '' : u.name || '',
        email: isMissingHash(u) ? '' : u.email || '',
      };
    }),
  );
}

export async function updateKnowledgeBase(id, data) {
  const kb = await redis.hgetall(kbKey(id));
  if (isMissingHash(kb)) throw new Error('Knowledge base not found');

  const updatedKb = {
    ...kb,
    ...data,
    ownerId: kb.ownerId, // 不允许通过 update 改归属
    updatedAt: Date.now(),
  };

  await redis.hset(kbKey(id), updatedKb);
  return updatedKb;
}

export async function deleteKnowledgeBase(id) {
  const kb = await redis.hgetall(kbKey(id));

  const documentIds = await redis.smembers(`${id}_documents`);
  for (const docId of documentIds) {
    await deleteDocument(docId);
  }

  const sessionIds = await redis.smembers(`${id}_chatsessions`);
  for (const sessionId of sessionIds) {
    await deleteChatSession(sessionId);
  }

  // 清理成员与反查索引，否则删库后「我的知识库」里会残留幽灵条目
  const memberIds = await redis.hkeys(kbMembersKey(id));
  if (!isMissingHash(kb) && kb.ownerId) memberIds.push(kb.ownerId);

  const pipe = redis.multi();
  for (const uid of memberIds) pipe.srem(userKbsKey(uid), id);
  pipe
    .del(kbKey(id))
    .del(kbMembersKey(id))
    .del(`${id}_documents`)
    .del(`${id}_chatsessions`)
    .srem('knowledgebases', id);
  await pipe.exec();
}

// ───────────────────────── Document ─────────────────────────

export async function addDocument(document) {
  const id = generateId('doc');
  const doc = {
    id,
    filename: document.filename,
    originalName: document.originalName,
    fileType: document.fileType,
    fileSize: document.fileSize,
    knowledgeBaseId: document.knowledgeBaseId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await redis.hset(`document_${id}`, doc);
  await redis.sadd(`${document.knowledgeBaseId}_documents`, id);

  return doc;
}

export async function updateDocumentChunkCount(documentId, count) {
  const doc = await redis.hgetall(`document_${documentId}`);
  if (isMissingHash(doc)) throw new Error('Document not found');

  await redis.hset(`document_${documentId}`, {
    ...doc,
    chunkCount: count,
    updatedAt: Date.now(),
  });
}

export async function getDocument(id) {
  const doc = await redis.hgetall(`document_${id}`);
  return isMissingHash(doc) ? null : doc;
}

export async function getDocumentsByKnowledgeBase(knowledgeBaseId) {
  const documentIds = await redis.smembers(`${knowledgeBaseId}_documents`);
  if (!documentIds || documentIds.length === 0) return [];

  const documents = await Promise.all(
    documentIds.map(async (id) => {
      const doc = await redis.hgetall(`document_${id}`);
      if (isMissingHash(doc)) return null;
      return { ...doc };
    }),
  );

  return documents.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDocument(id) {
  const doc = await redis.hgetall(`document_${id}`);
  if (isMissingHash(doc)) return;

  await redis.del(`document_${id}`);

  if (doc.knowledgeBaseId) {
    await redis.srem(`${doc.knowledgeBaseId}_documents`, id);
  }

  /*
   * 连带删掉磁盘上的原文件。
   * 原来只清 Redis 和 Qdrant，uploads/ 里的文件永远不删 —— 删一个知识库就多几个孤儿文件。
   * doc.filename 存的是磁盘名（上传时就重命名过），直接用它拼路径即可。
   * 文件不存在不算错误（可能已被手工清理），所以 catch 掉。
   */
  if (doc.filename) {
    await fs.unlink(path.join(process.cwd(), 'uploads', doc.filename)).catch(() => {});
  }
}

// ───────────────────────── Chat Session ─────────────────────────

export async function createChatSession(session) {
  const id = generateId('chat');
  const chatSession = {
    id,
    name: session.name || `Chat ${new Date().toLocaleDateString()}`,
    knowledgeBaseId: session.knowledgeBaseId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await redis.hset(`chatsession_${id}`, chatSession);
  await redis.sadd(`${session.knowledgeBaseId}_chatsessions`, id);
  await redis.sadd('chatsessions', id);

  return chatSession;
}

export async function getChatSession(id) {
  const session = await redis.hgetall(`chatsession_${id}`);
  return isMissingHash(session) ? null : session;
}

export async function getAllChatSessions() {
  const ids = await redis.smembers('chatsessions');
  if (!ids || ids.length === 0) return [];

  const sessions = await Promise.all(
    ids.map(async (id) => {
      const session = await redis.hgetall(`chatsession_${id}`);
      if (isMissingHash(session)) return null;

      const messageCount = await redis.llen(`chatsession_${id}_messages`);

      return {
        ...session,
        _count: {
          messages: messageCount || 0,
        },
      };
    }),
  );

  return sessions.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChatSessionsByKnowledgeBase(knowledgeBaseId) {
  const sessionIds = await redis.smembers(`${knowledgeBaseId}_chatsessions`);
  if (!sessionIds || sessionIds.length === 0) return [];

  const sessions = await Promise.all(
    sessionIds.map(async (id) => {
      const session = await redis.hgetall(`chatsession_${id}`);
      if (isMissingHash(session)) return null;

      const messageCount = await redis.llen(`chatsession_${id}_messages`);

      return {
        ...session,
        _count: {
          messages: messageCount || 0,
        },
      };
    }),
  );

  return sessions.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteChatSession(id) {
  const session = await redis.hgetall(`chatsession_${id}`);
  if (isMissingHash(session)) return;

  await redis.del(`chatsession_${id}_messages`);
  await redis.del(`chatsession_${id}`);

  if (session.knowledgeBaseId) {
    await redis.srem(`${session.knowledgeBaseId}_chatsessions`, id);
  }

  await redis.srem('chatsessions', id);
}

// ───────────────────────── Chat Message ─────────────────────────

export async function addChatMessage(message) {
  const id = generateId('msg');
  const chatMessage = {
    id,
    content: message.content,
    role: message.role,
    chatSessionId: message.chatSessionId,
    sources: message.sources ? JSON.stringify(message.sources) : null,
    createdAt: Date.now(),
  };

  await redis.hset(`message_${id}`, chatMessage);
  await redis.rpush(`chatsession_${message.chatSessionId}_messages`, id);
  await redis.hset(`chatsession_${message.chatSessionId}`, {
    updatedAt: Date.now(),
  });

  return chatMessage;
}

export async function getChatMessages(chatSessionId) {
  const messageIds = await redis.lrange(`chatsession_${chatSessionId}_messages`, 0, -1);
  if (!messageIds || messageIds.length === 0) return [];

  const messages = await Promise.all(
    messageIds.map(async (id) => {
      const message = await redis.hgetall(`message_${id}`);
      if (isMissingHash(message)) return null;

      if (message.sources) {
        try {
          message.sources = JSON.parse(message.sources);
        } catch {
          message.sources = [];
        }
      }

      return message;
    }),
  );

  return messages.filter(Boolean);
}

// ───────────────────────── Stats ─────────────────────────

/** 传 userId 时只统计「这个用户能看到的库」 */
export async function getDocumentCount(userId) {
  const kbs = userId ? await redis.smembers(userKbsKey(userId)) : await redis.smembers('knowledgebases');
  let count = 0;
  for (const kb of kbs) {
    count += await redis.scard(`${kb}_documents`);
  }
  return count;
}

export async function getChatSessionCount(userId) {
  if (!userId) return await redis.scard('chatsessions');

  const ids = await redis.smembers(userKbsKey(userId));
  let count = 0;
  for (const kb of ids) {
    count += await redis.scard(`${kb}_chatsessions`);
  }
  return count;
}
