import { getKnowledgeBase, getKbRole, addKbMember, removeKbMember, ROLE } from '@/lib/database';
import { audit } from '@/lib/audit';
import { HttpError } from './errors';

/**
 * 权限策略层：只做「能不能」，不做存储。
 * 数据都在 database.js（知识库 / 成员 / 反查索引），这里只负责判定和抛错。
 *
 * 分层的意义：如果把权限判断写进每个接口，就等于有 N 个地方可以漏；
 * 抽成一个函数后，只有这一个地方会判错，且可以被单测覆盖
 * （scripts/test-auth.mjs 里有 20 条）。
 */

export { ROLE };

/**
 * 唯一入口：确认 userId 对 kbId 至少有 minRole 权限，否则抛错。
 *
 * **无权限一律 404，不是 403**：
 * 403 等于告诉攻击者「这个 id 是真的，只是你没权限」，配合遍历就能
 * 枚举出全站有多少个库。404 把「不存在」和「不属于你」压成同一个答案。
 * 只有「有权限但级别不够」才给 403——那时对方已经知道库存在了，无信息泄露。
 */
export async function requireKb(kbId, userId, minRole = 'viewer') {
  if (!kbId || typeof kbId !== 'string') throw new HttpError(404, '知识库不存在');
  if (!userId) throw new HttpError(401, '未登录');

  const kb = await getKnowledgeBase(kbId);
  if (!kb) throw new HttpError(404, '知识库不存在');

  // 传 kb 进去，避免 getKbRole 再读一次 hash
  const role = await getKbRole(kbId, userId, kb);
  if (!role) {
    // 库存在但没有权限：这是最值得审计的事件（横向越权探测）
    await audit({ action: 'kb.access_denied', result: 'denied', actorId: userId, kbId });
    throw new HttpError(404, '知识库不存在');
  }

  if (ROLE[role] < ROLE[minRole]) {
    await audit({
      action: 'kb.access_denied',
      result: 'denied',
      actorId: userId,
      kbId,
      meta: { need: minRole, role },
    });
    throw new HttpError(403, `需要 ${minRole} 权限，当前是 ${role}`);
  }

  return { kb, role };
}

/** 加成员：只有 owner 能做 */
export async function addMember(actorId, kbId, targetUserId, role = 'viewer') {
  if (!['editor', 'viewer'].includes(role)) throw new HttpError(400, '角色只能是 editor 或 viewer');

  const { kb } = await requireKb(kbId, actorId, 'owner');
  if (targetUserId === kb.ownerId) throw new HttpError(400, 'owner 无需加入成员');

  await addKbMember(kbId, targetUserId, role);
  return { ok: true };
}

/** 移成员：本人可退出，owner 可移人，但 owner 不能退出自己（否则库无人可管） */
export async function removeMember(actorId, kbId, targetUserId) {
  const { kb } = await requireKb(kbId, actorId);
  if (actorId !== targetUserId && kb.ownerId !== actorId) {
    throw new HttpError(403, '只有 owner 可以移除他人');
  }
  if (targetUserId === kb.ownerId) {
    throw new HttpError(400, 'owner 不能退出，请先转让或删除知识库');
  }

  await removeKbMember(kbId, targetUserId);
  return { ok: true };
}
