'use server';

import { generateId } from 'ai';
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { buildAnswerChain, answerFromDocs } from '@/lib/rag/prompt';
import { Document } from '@langchain/core/documents';
import { RunnableLambda } from '@langchain/core/runnables';
import { createHistoryAwareRetriever } from 'langchain/chains/history_aware_retriever';
import { getVectorStore } from '@/lib/vectorStore';
import {
  getSettings,
  chatConfig,
  embeddingConfigForKb,
  ragConfig,
  fingerprint,
} from '@/lib/settings';
import { getMutableAIState, createAI } from 'ai/rsc';
import { requireUser } from '@/lib/auth/session';
import { requireKb } from '@/lib/auth/kbAccess';

/**
 * 召回条数、相似度阈值、追问改写开关全部来自用户设置（/settings → 检索与分块）。
 * 这几个是**查询时**参数，每次对话现取，改完立刻生效。
 */

/**
 * 把 LangChain 的 Document 规范成前端要的「来源」结构。
 *
 * 为什么要在服务端做这一步，而不是直接把 metadata 丢给前端：
 *   1. 前端不该关心 metadata 里字段叫什么、缺了怎么兜底
 *   2. index 必须从 1 开始，且和 prompt 里的 [citation:1] 严格一一对应，
 *      这个对应关系只有在这里才知道
 *   3. pageNumber / score 可能不存在，统一在这里规范化成 null
 */
function toSource(doc, zeroBasedIndex) {
  const m = doc.metadata ?? {};
  return {
    index: zeroBasedIndex + 1, // ★ 1 起，对应 [citation:1]
    documentId: m.documentId ?? null,
    // ★ 归属也带上：<AI> provider 挂在 chat/layout 上，消息会在所有 /chat/*
    //   页面之间共享 —— 消息可能来自 A 库而地址栏已是 B 库。
    //   引用自带归属后，「查看原文」就不再依赖当前页面，不会误报 403。
    knowledgeBaseId: m.knowledgeBaseId ?? null,
    fileName: m.fileName ?? '未知文件',
    fileType: m.fileType ?? null, // 决定「查看原文」用哪种预览方式
    chunkIndex: m.chunkIndex ?? null,
    pageNumber: m.pageNumber ?? null, // 只有 PDF 有
    score: typeof m.score === 'number' ? Number(m.score.toFixed(4)) : null,
    // 检索来源信息：混合检索时带上融合排名与两路分数
    retrievalMode: m.retrieval?.mode ?? null,
    retrievalFusion: m.retrieval?.fusion ?? null,
    retrievalRank: m.retrieval?.rank ?? null,
    fusedScore: typeof m.retrieval?.fusedScore === 'number' ? Number(m.retrieval.fusedScore.toFixed(4)) : null,
    denseScore: typeof m.retrieval?.denseScore === 'number' ? Number(m.retrieval.denseScore.toFixed(4)) : null,
    content: doc.pageContent, // 原文，引用卡片展开时显示
  };
}

class RAG {
  /**
   * @param {string} knowledgeBaseId
   * @param {{baseUrl:string,apiKey:string,model:string,temperature:number,maxTokens:number}} chat
   * @param {{baseUrl:string,apiKey:string,model:string,vectorSize:number}} embedding
   */
  constructor(knowledgeBaseId, chat, embedding, rag) {
    this.knowledgeBaseId = knowledgeBaseId;
    this.chat = chat;
    this.embedding = embedding;
    this.rag = rag;
    this.qaChain = null;
    this.retriever = null;
    this.historyAwareRetriever = null;
  }

  async initialize() {
    if (this.historyAwareRetriever) return;

    // 只支持 OpenAI 兼容协议：换 vendor 就是换 baseUrl + model，代码不动
    const llm = new ChatOpenAI({
      apiKey: this.chat.apiKey || 'local',
      configuration: { baseURL: this.chat.baseUrl },
      model: this.chat.model,
      temperature: Number(this.chat.temperature ?? 0),
      ...(this.chat.maxTokens ? { maxTokens: Number(this.chat.maxTokens) } : {}),
      streaming: true,
    });

    const vectorStore = await getVectorStore(this.knowledgeBaseId, this.embedding, this.rag);

    /**
     * 带相似度分数的检索器。
     *
     * 不用 vectorStore.asRetriever() 的原因：它只返回 Document，拿不到分数。
     * 而分数有两个用处：引用卡片上显示「这条有多相关」，以及将来做阈值拒答。
     *
     * 用 RunnableLambda 包一层，是因为 createHistoryAwareRetriever 只要求
     * 传进来的东西有 .invoke()，不强制是 BaseRetriever。
     */
    const scoredRetriever = RunnableLambda.from(async (query) => {
      const hits = await vectorStore.similaritySearchWithScore(query, this.rag.topK);

      // 相似度阈值：0 表示不启用。低于阈值的块直接丢掉，宁可不答也不要答偏。
      const kept =
        this.rag.scoreThreshold > 0
          ? hits.filter(([, score]) => score >= this.rag.scoreThreshold)
          : hits;

      return kept.map(
        ([doc, score]) =>
          new Document({
            pageContent: doc.pageContent,
            metadata: { ...doc.metadata, score },
          }),
      );
    });

    // 追问改写：把「那它呢」这类依赖上下文的问题改写成独立问题，再去检索
    /*
     * 改写 prompt。实测教训：只写一句 "Don't answer it" 对 2B 模型没用 ——
     * 它会**直接回答**这个问题，然后我们拿一整段答案去向量检索，召回质量崩掉。
     * 所以这里改成：明确角色 + 硬性输出约束 + few-shot 示例。
     */
    const contextualizeQPrompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You are a query rewriter, not an assistant. You NEVER answer questions.

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
Output: 查询cpu告警的查询路径`,
      ],
      new MessagesPlaceholder('chat_history'),
      ['human', '{input}'],
    ]);

    this.retriever = scoredRetriever;

    this.historyAwareRetriever = await createHistoryAwareRetriever({
      llm,
      retriever: scoredRetriever,
      rephrasePrompt: contextualizeQPrompt,
    });

    /**
     * 最终回答用的 chain。
     *
     * 注意这里**没有**用 createStuffDocumentsChain：
     *   它的 documentPrompt 只能拿到 {page_content}，没法给每段加编号，
     *   而模型看到的 context 一旦没有编号，[citation:x] 就只能靠它自己「数第几段」——
     *   数错是常事，而且你从界面上根本看不出来。
     *
     * 所以我们自己拼 context（见 performRAG），prompt 里的 {context} 直接收字符串，
     * 用最普通的 prompt → llm → 取纯文本 三段式。
     */
    // prompt 与编号逻辑与评测共用（src/lib/rag/prompt.js），保证「测的就是线上的」
    this.qaChain = buildAnswerChain(llm);
  }

  async performRAG(query, chatHistory = []) {
    await this.initialize();

    /*
     * 追问改写是可选优化：关掉时直接把原问题拿去检索。
     * 关掉的典型场景 —— 每轮都是独立问题（日志、告警码），改写成一次额外推理，
     * 本地 2B 模型要多等 1~3 秒，不如省了。
     */
    const relevantDocs = this.rag.queryRewrite
      ? await this.historyAwareRetriever.invoke({ input: query, chat_history: chatHistory })
      : await this.retriever.invoke(query);

    /**
     * ★ 检索为空就立刻返回，绝不把空 context 交给模型。
     *
     * 实测：检索 0 条时 context 是空字符串，模型会跑 125 秒并返回空内容 ——
     * 用户盯着屏幕等两分钟什么都看不到，比报错还糟。
     * 而且这种情况压根没有调用模型的必要。
     *
     * 顺带避免了另一个副作用：getVectorStore 对不存在的集合会「建一个空的」，
     * 空知识库被提问一次就会在 Qdrant 里多出一个垃圾集合。
     */
    if (relevantDocs.length === 0) {
      return {
        answer: '这个知识库里没有检索到相关内容。请确认文档已经上传，或者换一种问法。',
        sources: [],
      };
    }

    /**
     * ★ 给每段 context 显式编号。
     *
     * 这一步是引用准确率的前提：
     *   编号前 —— 模型看到的是「- 内容1\n- 内容2」，要引用得自己数第几段
     *   编号后 —— 模型看到的是「[1] 内容1\n[2] 内容2」，直接抄编号
     *
     * 而且编号让我们有了唯一的权威映射：sources[i].index === i + 1
     */
    const { answer } = await answerFromDocs({
      chain: this.qaChain,
      docs: relevantDocs,
      query,
      chatHistory,
    });

    const sources = relevantDocs.map(toSource);

    /*
     * 兜底：模型偶尔会返回空白。
     * 实测过两种触发场景（对话历史畸形、上下文为空），现象都是「跑 100 秒然后输出空」。
     * 与其给用户一个空气泡，不如明确说这次没生成成功。
     * 注意检索本身是成功的，所以 sources 照常返回。
     */
    if (!answer || !answer.trim()) {
      return {
        answer: '模型这次没有生成有效回答（可能是上下文过长或对话轮次不兼容），请重试或换一种问法。',
        sources,
      };
    }

    return { answer, sources };
  }
}

/**
 * RAG 实例缓存。
 *
 * ⚠️ 缓存键必须带上配置指纹：原来只按 knowledgeBaseId 缓存，用户一改模型，
 *    进程里那个旧实例还会继续用老 baseUrl 跑到底（看起来像"设置没生效"）。
 *    指纹一变 → 新实例；旧实例留给 GC。
 */
const ragInstances = new Map();

const instanceKey = (kbId, chat, embedding, rag) =>
  [
    kbId,
    fingerprint(chat),
    fingerprint(embedding),
    rag.topK,
    rag.scoreThreshold,
    rag.queryRewrite ? 1 : 0,
  ].join('::');

async function getRagInstance(knowledgeBaseId, chat, embedding, rag) {
  const key = instanceKey(knowledgeBaseId, chat, embedding, rag);
  if (!ragInstances.has(key)) {
    const instance = new RAG(knowledgeBaseId, chat, embedding, rag);
    await instance.initialize();
    ragInstances.set(key, instance);
  }
  return ragInstances.get(key);
}

export async function continueConversation(input, knowledgeBaseId) {
  /*
   * ⚠️ Server Action 也是一个 POST 端点，可以被直接构造请求调用，
   * 不经过页面也不经过任何前端逻辑。所以鉴权必须写在这里。
   * knowledgeBaseId 由客户端传入，属于不可信输入。
   */
  const user = await requireUser();
  await requireKb(knowledgeBaseId, user.id, 'viewer');

  const aiState = getMutableAIState();

  // 先取历史再追加本轮，否则当前问题会在 prompt 里出现两次
  // （一次来自 chat_history，一次来自 {input}）
  const messages = aiState.get().messages || [];
  const chatHistory = messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  /*
   * ★ 用户消息必须一起存进 aiState。
   *
   * 踩过的大坑：原来只 append assistant 的回答（用户消息只进了客户端的 useUIState），
   * 于是 aiState.messages 变成 [assistant, assistant, ...] —— 一串没有 user 的对话。
   * 这种畸形历史交给 MessagesPlaceholder 后，模型跑满 100 秒然后**输出空白**，
   * 界面上就是一个空的灰盒子配着正常的引用列表。
   *
   * 修复：user 和 assistant 成对写入，保持正常的交替结构。
   */
  const userMessage = { id: `u-${Date.now()}`, role: 'user', content: input, sources: [] };

  let assistantMessage;
  try {
    // 当前用户的模型配置 + 这个知识库钉住的 embedding 模型/维度
    const settings = await getSettings(user.id);
    const chat = chatConfig(settings);
    const embedding = await embeddingConfigForKb(knowledgeBaseId, settings);
    const ragParams = ragConfig(settings);

    const rag = await getRagInstance(knowledgeBaseId, chat, embedding, ragParams);
    const { answer, sources } = await rag.performRAG(input, chatHistory);
    assistantMessage = {
      id: generateId(),
      role: 'assistant',
      content: answer,
      sources, // ★ 来源数据
    };
  } catch (error) {
    console.error('Error in continueConversation:', error);
    assistantMessage = {
      id: generateId(),
      role: 'assistant',
      content: `回答失败：${error.message}`,
      sources: [],
      failed: true,
    };
  }

  // 无论成功失败都写入，保证历史结构始终是 user/assistant 交替
  aiState.done({
    ...aiState.get(),
    messages: [...messages, userMessage, assistantMessage],
  });

  return assistantMessage;
}

export const AI = createAI({
  actions: {
    continueConversation,
  },
  initialAIState: { messages: [] },
  initialUIState: [],
});
