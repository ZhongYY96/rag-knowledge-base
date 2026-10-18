/**
 * 外部依赖配置的唯一入口。
 *
 * 原则：**连接信息只从环境变量来，永远不进代码库。**
 *   · 仓库里只放 .env.example（占位符，无真实值）
 *   · 本地用 .env.local（已在 .gitignore）
 *   · 线上由平台注入（Vercel/1Panel/K8s Secret/Compose env_file）
 *
 * 这里做两件事：
 *   1. 校验：生产环境缺关键变量直接启动失败，而不是运行到一半才 500
 *   2. 脱敏：日志里只打印 host/库名，密码一律 ***
 */

const env = process.env;

const maskUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    if (u.username && u.protocol !== 'redis:') u.username = u.username;
    return u.toString();
  } catch {
    return String(raw).replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  }
};

export const config = {
  redis: {
    url: env.REDIS_URL || 'redis://127.0.0.1:6379',
  },
  qdrant: {
    url: env.QDRANT_URL || 'http://127.0.0.1:6333',
    apiKey: env.QDRANT_API_KEY || '',
    vectorSize: Number(env.QDRANT_VECTOR_SIZE) || 1024,
  },
  auth: {
    secret: env.AUTH_SECRET || '',
  },
  llm: {
    baseUrl: env.OPENAI_BASE_URL || 'http://127.0.0.1:8000/v1',
    model: env.OPENAI_MODEL || 'MiniCPM5-2B',
  },
  embedding: {
    baseUrl: env.EMBEDDING_BASE_URL || 'http://127.0.0.1:8001/v1',
    model: env.EMBEDDING_MODEL || 'bge-m3',
  },
};

/** 生产环境必须显式提供的外部依赖；缺了就别启动 */
const REQUIRED_IN_PRODUCTION = ['REDIS_URL', 'QDRANT_URL', 'AUTH_SECRET'];

export function assertConfig() {
  if (env.NODE_ENV !== 'production') return;

  const missing = REQUIRED_IN_PRODUCTION.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `缺少必需的环境变量：${missing.join(', ')}。` +
        `请参考 .env.example 配置后重启；生产环境不允许回退到本地默认值。`,
    );
  }

  if (String(env.AUTH_SECRET).length < 32) {
    console.warn('[config] AUTH_SECRET 长度不足 32，建议换成随机串：openssl rand -hex 32');
  }
}

/** 启动时打印一次脱敏后的依赖地址，方便排查"连错库" */
export function describeConfig() {
  return [
    `redis=${maskUrl(config.redis.url)}`,
    `qdrant=${config.qdrant.url}${config.qdrant.apiKey ? ' (apiKey 已设置)' : ''}`,
    `llm=${config.llm.baseUrl}`,
    `embedding=${config.embedding.baseUrl}`,
  ].join(' | ');
}

let logged = false;
export function logConfigOnce() {
  if (logged) return;
  logged = true;
  console.log('[config]', describeConfig());
}
