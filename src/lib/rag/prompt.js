import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';

/**
 * 回答用的 prompt 与拼装逻辑。
 *
 * 抽出来的唯一原因：**对话和评测必须用同一份 prompt**。
 * 如果评测自己写一套，测的就不是线上那套，数字再好看也没意义。
 */

export const ANSWER_SYSTEM_PROMPT = `Answer the question concisely using ONLY the provided contexts.

Context:
{context}

Each context is numbered like [1], [2], [3]. When you use information from a context, cite it inline as [citation:N] where N is that number — for example: "接收光功率应保持在 -8dBm 到 -27dBm 之间 [citation:2]。". Only cite numbers that actually appear above — never invent one.

Hard rules (violating any of these is worse than saying you don't know):
0. Answer ONLY the last user message. The chat history exists only to resolve references. Never repeat a previous answer and never carry a topic from the history into this answer unless the last message explicitly refers to it.
1. Never introduce an entity — device type, table name, alert type, metric name, field name — that appears in NEITHER the question NOR the contexts. If the user says "某指标" (some metric), do not guess which metric it is.
2. If the contexts do not contain the answer, say plainly that the knowledge base has no relevant content, and name what is missing. Do not speculate about the user's intent.
3. If the question is too vague to answer (for example it refers to "某指标" without naming it), ask the user for the specific name instead of assuming.
4. Never claim the contexts discuss a topic they do not mention.

Keep it extremely short: one conclusion sentence plus at most 3 bullet points. Aim for 80 Chinese characters; never exceed 150. Do not repeat the question, do not add pleasantries, do not restate the context.

Be accurate, professional, and unbiased. Respond in the same language as the question except for code and specific terms.`;

/**
 * ★ 给每段 context 显式编号。
 *
 * 这一步是引用准确率的前提：
 *   编号前 —— 模型看到的是「- 内容1\n- 内容2」，要引用得自己数第几段
 *   编号后 —— 模型看到的是「[1] 内容1\n[2] 内容2」，直接抄编号
 *
 * 而且编号让我们有了唯一的权威映射：sources[i].index === i + 1
 */
export const formatContext = (docs) =>
  docs.map((doc, i) => `[${i + 1}] ${doc.pageContent}`).join('\n\n');

export function buildAnswerChain(llm) {
  const qaPrompt = ChatPromptTemplate.fromMessages([
    ['system', ANSWER_SYSTEM_PROMPT],
    new MessagesPlaceholder('chat_history'),
    ['human', '{input}'],
  ]);
  // 必须接 StringOutputParser：调用方拿到的就是字符串，不是 AIMessage
  return qaPrompt.pipe(llm).pipe(new StringOutputParser());
}

/** 输入文档 → 返回 { answer, context }，对话与评测共用 */
export async function answerFromDocs({ chain, docs, query, chatHistory = [] }) {
  const context = formatContext(docs);
  const answer = await chain.invoke({
    input: query,
    chat_history: chatHistory,
    context,
  });
  return { answer, context };
}
