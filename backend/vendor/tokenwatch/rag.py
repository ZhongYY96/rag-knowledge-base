"""tokenwatch/rag.py — RAG cost tracking and optimization."""

from dataclasses import dataclass
from tokenwatch.config import TokenwatchConfig
from tokenwatch.tokens import estimate_tokens


@dataclass
class RAGCostBreakdown:
    embedding_tokens: int = 0
    embedding_cost_usd: float = 0.0
    chunks_retrieved: int = 0
    chunks_after_rerank: int = 0
    rerank_cost_usd: float = 0.0
    context_tokens: int = 0
    context_cost_usd: float = 0.0
    query_tokens: int = 0
    output_tokens: int = 0
    generation_cost_usd: float = 0.0
    total_cost_usd: float = 0.0
    context_waste_pct: float = 0.0


class RAGCostTracker:
    def __init__(self, config: TokenwatchConfig, embedding_rate_per_million: float = 0.02, rerank_rate_per_query: float = 0.0005):
        self.config = config
        self.embedding_rate = embedding_rate_per_million
        self.rerank_rate = rerank_rate_per_query
        self.history: list[RAGCostBreakdown] = []

    def track_request(self, query: str, retrieved_chunks: list[str], reranked_chunks: list[str] | None = None, llm_model: str = "claude-sonnet-4-20250514", output_tokens: int = 500) -> RAGCostBreakdown:
        query_tokens = estimate_tokens(query)
        embedding_cost = (query_tokens / 1_000_000) * self.embedding_rate
        used = reranked_chunks if reranked_chunks else retrieved_chunks
        rerank_cost = self.rerank_rate if reranked_chunks else 0.0
        context_tokens = sum(estimate_tokens(c) for c in used)
        pricing = self.config.get_model(llm_model)
        gen_cost = pricing.cost_for_tokens(input_tokens=query_tokens + context_tokens, output_tokens=output_tokens)
        ctx_cost = (context_tokens / 1_000_000) * pricing.input_rate
        waste = 0.0
        if len(used) > 3:
            extra = sum(estimate_tokens(c) for c in used[3:])
            waste = (extra / context_tokens * 100) if context_tokens > 0 else 0
        bd = RAGCostBreakdown(
            embedding_tokens=query_tokens, embedding_cost_usd=embedding_cost,
            chunks_retrieved=len(retrieved_chunks), chunks_after_rerank=len(used),
            rerank_cost_usd=rerank_cost, context_tokens=context_tokens,
            context_cost_usd=ctx_cost, query_tokens=query_tokens,
            output_tokens=output_tokens, generation_cost_usd=gen_cost,
            total_cost_usd=embedding_cost + rerank_cost + gen_cost, context_waste_pct=waste,
        )
        self.history.append(bd)
        return bd
