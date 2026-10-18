#!/usr/bin/env node
/**
 * 一次性迁移脚本：给「没有 ownerId 的历史知识库」补上归属。
 *
 * 为什么必须迁：新模型里 kb.ownerId 是权限判断的唯一依据，
 * 历史库没有这个字段 → requireKb() 永远返回 404 → 老数据全部「消失」。
 *
 * 除了补 ownerId，还要补一条反查索引 `user:{ownerId}:kbs`，
 * 否则列表页 listKnowledgeBasesForUser() 查不到这些老库。
 *
 * 用法：
 *   LEGACY_OWNER_ID=user_xxx node scripts/migrate-kb-owner.mjs          # 真写
 *   DRY_RUN=1 LEGACY_OWNER_ID=user_xxx node scripts/migrate-kb-owner.mjs # 只打印
 *
 * ⚠️ 需要 ioredis（项目依赖里已有）。这个仓库快照没有 package.json，
 *    如果报 Cannot find module 'ioredis'，先在能跑的项目目录里执行本脚本。
 */
import Redis from 'ioredis';

const DRY_RUN = process.env.DRY_RUN === '1';
let OWNER = process.env.LEGACY_OWNER_ID;

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 3,
});

const isEmpty = (h) => !h || Object.keys(h).length === 0;

/**
 * 没传 LEGACY_OWNER_ID 时的兜底：如果只有一个用户，就认他。
 * 多个用户时必须显式指定，否则等于把别人的库随便送人。
 */
async function resolveOwner() {
  if (OWNER) return OWNER;
  const ids = await redis.smembers('users');
  if (ids.length === 1) {
    console.log(`未指定 LEGACY_OWNER_ID，检测到唯一用户 ${ids[0]}，就用它\n`);
    return ids[0];
  }
  if (ids.length === 0) {
    throw new Error('还没有任何用户，请先在 /login 注册一个账号，再跑这个脚本');
  }
  throw new Error(
    `有 ${ids.length} 个用户，必须显式指定归属：\n` +
      `  LEGACY_OWNER_ID=<userId> node scripts/migrate-kb-owner.mjs\n` +
      `可选：${ids.join(', ')}`,
  );
}

async function main() {
  OWNER = await resolveOwner();
  if (!(await redis.exists(`user:${OWNER}`))) {
    throw new Error(`user:${OWNER} 不存在，先把 owner 账号注册出来`);
  }

  const ids = await redis.smembers('knowledgebases');
  console.log(`扫描到 ${ids.length} 个知识库，DRY_RUN=${DRY_RUN}\n`);

  let migrated = 0;
  let skipped = 0;

  for (const id of ids) {
    const kb = await redis.hgetall(`knowledgebase_${id}`);
    if (isEmpty(kb)) {
      console.warn(`- ${id}: Redis 里查不到，跳过（可能是脏索引）`);
      skipped++;
      continue;
    }

    if (kb.ownerId) {
      console.log(`- ${id}: 已有 ownerId=${kb.ownerId}，跳过`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`- ${id}: 缺 ownerId → 将归给 ${OWNER}，并补 user:${OWNER}:kbs`);
      migrated++;
      continue;
    }

    await redis
      .multi()
      .hset(`knowledgebase_${id}`, 'ownerId', OWNER)
      .hset(`knowledgebase_${id}`, 'visibility', 'private')
      .sadd(`user:${OWNER}:kbs`, id)
      .exec();

    migrated++;
    console.log(`- ${id}: 已归给 ${OWNER}`);
  }

  console.log(
    `\n${DRY_RUN ? '（干跑，未写入）' : '完成'}：待迁移/已迁移 ${migrated} 个，跳过 ${skipped} 个`,
  );
  if (DRY_RUN && migrated > 0) {
    console.log('确认无误后去掉 DRY_RUN=1 再跑一次');
  }
}

main()
  .catch((e) => {
    console.error('迁移失败:', e.message);
    process.exitCode = 1;
  })
  .finally(() => redis.quit());
