import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { createHistoryAwareRetriever } from 'langchain/chains/history_aware_retriever';
import { RunnableLambda } from '@langchain/core/runnables';
import { Document } from '@langchain/core/documents';
import { getVectorStore } from '@/lib/vectorStore';
import { buildAnswerChain, answerFromDocs } from '@/lib/rag/prompt';
import { historyFor } from '@/lib/rag/followup';
import { createChatProvider } from '@/lib/rag/provider';
import { generateText } from 'ai';
import { ANSWER_SYSTEM_PROMPT, formatContext } from '@/lib/rag/prompt';

/**
 * RAG 执行内核（不依赖 ai/rsc、不依赖请求上下文）。
 *
 * 抽出来的原因：会话管理要在**后台**跑生成，不能绑在页面/请求生命周期上。
 * 原来这段逻辑写在 chat/actions.jsx 的 RAG 类里，只能被 Server Action 调用。
 */

const REWRITE_PROMPT = `You are a query rewriter, not an assistant. You NEVER answer questions.

Rewrite the follow-up message into a standalone search query that can be understood without the chat history.

Hard rules:
- Output ONLY the rewritten query on a single line.
- No explanations, no answers, no preamble, no "Rewritten:" prefix.
- If the follow-up is already standalone, output it unchanged.
- Keep the original language.

Example 1
Follow-up: 那它呢
Output: 光猫掉线怎么排查

Example 2
Follow-up: 包括具体的库表
Output: 查询 CPU 告警路径涉及的具体库表

Example 3
Follow-up: 查询cpu告警的查询路径
Output: 查询cpu告警的查询路径`;

/**
 * 非流式生成（评测用）。走 AI SDK 而不是 LangChain chain：
 * 实测 LangChain 的 chain.invoke 在 Next 的 after() 里会挂住不返回，
 * 而 AI SDK 的 generateText 正常 —— 对话链路也已经是 AI SDK，保持一致。
 */
export async function generateAnswer({ chat, question, docs, history = [] }) {
  const provider = createChatProvider(chat);
  const system = ANSWER_SYSTEM_PROMPT.replace('{context}', formatContext(docs));
  const { text } = await generateText({
    model: provider.chat(chat.model),
    system,
    messages: [...historyFor(question, history), { role: 'user', content: question }],
    temperature: Number(chat.temperature ?? 0),
    ...(chat.maxTokens ? { maxTokens: Number(chat.maxTokens) } : {}),
  });
  return text || '';
}

export function toSource(doc, zeroBasedIndex) {
  const m = doc.metadata ?? {};
  return {
    index: zeroBasedIndex + 1,
    documentId: m.documentId ?? null,
    knowledgeBaseId: m.knowledgeBaseId ?? null,
    fileName: m.fileName ?? '未知文件',
    fileType: m.fileType ?? null,
    chunkIndex: m.chunkIndex ?? null,
    pageNumber: m.pageNumber ?? null,
    score: typeof m.score === 'number' ? Number(m.score.toFixed(4)) : null,
    retrievalMode: m.retrieval?.mode ?? null,
    retrievalFusion: m.retrieval?.fusion ?? null,
    retrievalRank: m.retrieval?.rank ?? null,
    fusedScore: typeof m.retrieval?.fusedScore === 'number' ? Number(m.retrieval.fusedScore.toFixed(4)) : null,
    denseScore: typeof m.retrieval?.denseScore === 'number' ? Number(m.retrieval.denseScore.toFixed(4)) : null,
    content: doc.pageContent,
  };
}

/**
 * 只做检索：返回命中的 Document[]。
 * 非流式（eval/CLI）和流式（chatTurn）共用这一份，避免两套召回逻辑。
 */
export async function retrieveDocs({ kbId, question, history = [], chat, embedding, rag }) {
  const llm = new ChatOpenAI({
    apiKey: chat.apiKey || 'local',
    configuration: { baseURL: chat.baseUrl },
    model: chat.model,
    temperature: Number(chat.temperature ?? 0),
    streaming: false,
  });

  const store = await getVectorStore(kbId, embedding, rag);

  const scoredRetriever = RunnableLambda.from(async (query) => {
    const hits = await store.similaritySearchWithScore(query, rag.topK);
    const kept =
      rag.scoreThreshold > 0 ? hits.filter(([, score]) => score >= rag.scoreThreshold) : hits;
    return kept.map(
      ([doc, score]) => new Document({ pageContent: doc.pageContent, metadata: { ...doc.metadata, score } }),
    );
  });

  const history$ = historyFor(question, history);
  if (rag.queryRewrite && history$.length > 0) {
    const rewriter = await createHistoryAwareRetriever({
      llm,
      retriever: scoredRetriever,
      rephrasePrompt: ChatPromptTemplate.fromMessages([
        ['system', REWRITE_PROMPT],
        new MessagesPlaceholder('chat_history'),
        ['human', '{input}'],
      ]),
    });

    /*
     * 改写要调一次 LLM —— 本地模型只有 2.3 tok/s 且 PARALLEL=1，
     * 一旦模型正忙（另一轮生成/评测），改写会排队几十秒，
     * 表现就是「卡在检索里直到整轮超时」。
     * 所以给改写加硬超时：超了就退回原问题，绝不拖垮整轮。
     */
    const REWRITE_TIMEOUT_MS = 3000;
    const started = Date.now();
    try {
      const docs = await Promise.race([
        rewriter.invoke({ input: question, chat_history: history$ }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('rewrite_timeout')), REWRITE_TIMEOUT_MS),
        ),
      ]);
      console.log(`[rag] 查询改写完成 ${Date.now() - started}ms`);
      return docs;
    } catch (error) {
      console.warn(`[rag] 查询改写跳过（${error.message}，${Date.now() - started}ms），用原问题检索`);
      return scoredRetriever.invoke(question);
    }
  }
  return scoredRetriever.invoke(question);
}

/**
 * 一次问答：检索 → 拼上下文 → 生成 → 返回 { answer, sources }
 * @param {{kbId:string, question:string, history:Array<{role,content}>, chat:object, embedding:object, rag:object}} p
 */
export async function runRag({ kbId, question, history = [], chat, embedding, rag }) {
  const llm = new ChatOpenAI({
    apiKey: chat.apiKey || 'local',
    configuration: { baseURL: chat.baseUrl },
    model: chat.model,
    temperature: Number(chat.temperature ?? 0),
    ...(chat.maxTokens ? { maxTokens: Number(chat.maxTokens) } : {}),
    streaming: false,
  });

  const docs = await retrieveDocs({ kbId, question, history, chat, embedding, rag });

  if (!docs.length) {
    return {
      answer: '这个知识库里没有检索到相关内容。请确认文档已经上传，或者换一种问法。',
      sources: [],
    };
  }

  const chain = buildAnswerChain(llm);
  // 同上：非追问时不带历史，避免模型沿用上一轮的主题
  const { answer } = await answerFromDocs({
    chain,
    docs,
    query: question,
    chatHistory: historyFor(question, history),
  });

  if (!answer || !answer.trim()) {
    return {
      answer: '模型这次没有生成有效回答（可能是上下文过长或对话轮次不兼容），请重试或换一种问法。',
      sources: docs.map(toSource),
    };
  }

  return { answer, sources: docs.map(toSource) };
}
