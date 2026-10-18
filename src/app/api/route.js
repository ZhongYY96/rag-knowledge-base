import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { redis } from '@/lib/redis';
import { requireUser } from '@/lib/auth/session';
import { HttpError } from '@/lib/auth/errors';
import { getSettings, chatConfig } from '@/lib/settings';

export const dynamic = 'force-dynamic';

/**
 * 通用助手接口。
 *
 * 模型配置不再写死在模块顶层，而是**按请求、按用户**从 settings 里解析：
 *   baseUrl / apiKey / model 全部来自 /settings 页面，只支持 OpenAI 兼容协议。
 *
 * 仍然走 .chat() 而不是直接调 provider —— 强制使用 /v1/chat/completions，
 * 因为 vLLM / LM Studio / llama.cpp 这类服务只实现这条路。
 */

const promptSchema = z.object({
  text: z.string().min(1).max(500, 'Prompt must be between 1 and 500 characters.'),
});

const RATE_LIMIT = 5; // 每窗口允许的请求数
const RATE_WINDOW_MS = 10_000; // 10 秒（原来在 middleware 里的 slidingWindow(5, '10 s')）

/**
 * 取客户端 IP。
 * 注意：App Router 的 Request 上没有 `request.ip`（原 middleware 代码用了它，
 * 结果永远拿到 undefined 而回退成 '127.0.0.1'，等于所有用户共用一个限流桶）。
 */
const clientIp = (req) =>
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  req.headers.get('x-real-ip') ||
  '127.0.0.1';

/** 滑动窗口限流：用 ZSET 记录窗口内的请求时间戳 */
const checkRateLimit = async (identifier) => {
  const key = `ratelimit:${identifier}`;
  const now = Date.now();

  const results = await redis
    .multi()
    .zremrangebyscore(key, 0, now - RATE_WINDOW_MS) // 清掉滑出窗口的旧记录
    .zadd(key, now, `${now}-${Math.random()}`) // 记下本次请求
    .zcard(key) // 数窗口内还剩几条
    .pexpire(key, RATE_WINDOW_MS) // 兜底过期，避免冷 key 永久残留
    .exec();

  // exec() 返回 [[err, res], ...]，第 3 条（下标 2）是 zcard
  const count = results[2][1];
  return { success: count <= RATE_LIMIT, count };
};

/**
 * 每日消息配额。
 * owner 可能是 userId（已登录）或 `anon:<ip>`（未登录）。
 */
const checkMessageQuota = async (owner) => {
  const today = new Date().toISOString().split('T')[0];
  const key = `message_count:${owner}:${today}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 24 * 60 * 60);
  }

  return count <= 10;
};

export async function POST(req) {
  try {
    const ip = clientIp(req);
    const { success } = await checkRateLimit(ip);
    if (!success) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const validatedData = promptSchema.parse(body);

    // 必须登录：这个接口会真的调模型，匿名开放等于给外部送免费算力
    const user = await requireUser();
    const quotaOwner = user.id;

    const quotaAvailable = await checkMessageQuota(quotaOwner);
    if (!quotaAvailable) {
      return new Response(
        JSON.stringify({ error: 'Message quota exceeded. You can only send 10 messages per day.' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const settings = await getSettings(user.id);
    const chat = chatConfig(settings);

    const provider = createOpenAI({
      apiKey: chat.apiKey || 'local',
      baseURL: chat.baseUrl,
    });

    const result = await generateText({
      system: "I'm happy to assist you in any way I can. How can I be of service today?",
      prompt: validatedData.text,
      model: provider.chat(chat.model),
      maxTokens: Math.min(Number(chat.maxTokens) || 512, 2048),
    });

    const message = {
      id: uuidv4(),
      role: result.response.messages[0].role,
      content: result.text,
    };

    return new Response(JSON.stringify({ message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.error('Error processing prompt:', error);

    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Failed to process prompt' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
