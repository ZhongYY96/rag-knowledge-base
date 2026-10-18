import { createOpenAI } from '@ai-sdk/openai';

/**
 * 本地 OpenAI 兼容端点的 provider 工厂。
 *
 * 两个必须的适配（都是实测出来的）：
 *  1. 必须 .chat()：provider(model) 在部分版本会打到 /v1/responses
 *  2. 注入 chat_template_kwargs.enable_thinking=false：推理模型会先吐
 *     reasoning_content，AI SDK 不把它映射成 text-delta，正文会一个字都没有
 */
export function createChatProvider(chat) {
  return createOpenAI({
    apiKey: chat.apiKey || 'local',
    baseURL: chat.baseUrl,
    fetch: async (url, init) => {
      if (init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body);
          body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
          // 让服务端在流式响应里带上 usage（不支持的实现会忽略这个字段）
          if (body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
          init = { ...init, body: JSON.stringify(body) };
        } catch {
          /* 非 JSON 体原样发 */
        }
      }
      return fetch(url, init);
    },
  });
}
