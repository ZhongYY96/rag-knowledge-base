"""tokenwatch/batch.py — Batch processing for LLM workloads."""

import time
from dataclasses import dataclass, field
import anthropic
from tokenwatch.config import TokenwatchConfig


@dataclass
class BatchRequest:
    custom_id: str
    model: str
    max_tokens: int
    messages: list[dict]
    system: str = ""
    metadata: dict = field(default_factory=dict)


@dataclass
class BatchJob:
    batch_id: str
    request_count: int
    status: str
    created_at: str
    custom_ids: list[str]


@dataclass
class BatchResult:
    custom_id: str
    response: dict | None
    error: dict | None
    usage: dict | None


class BatchProcessor:
    def __init__(self, config: TokenwatchConfig, client: anthropic.Anthropic | None = None):
        self.config = config
        self.client = client or anthropic.Anthropic()

    def create_batch(self, requests: list[BatchRequest]) -> BatchJob:
        batch_requests = []
        for req in requests:
            params = {"model": req.model, "max_tokens": req.max_tokens, "messages": req.messages}
            if req.system:
                params["system"] = req.system
            batch_requests.append({"custom_id": req.custom_id, "params": params})
        result = self.client.messages.batches.create(requests=batch_requests)
        return BatchJob(
            batch_id=result.id, request_count=len(requests),
            status=result.processing_status, created_at="",
            custom_ids=[r.custom_id for r in requests],
        )

    def check_status(self, batch_id: str) -> str:
        return self.client.messages.batches.retrieve(batch_id).processing_status

    def get_results(self, batch_id: str) -> list[BatchResult]:
        results = []
        for result in self.client.messages.batches.results(batch_id):
            if result.result.type == "succeeded":
                msg = result.result.message
                results.append(BatchResult(
                    custom_id=result.custom_id,
                    response={"content": [{"type": b.type, "text": getattr(b, "text", "")} for b in msg.content]},
                    error=None,
                    usage={"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens},
                ))
            else:
                results.append(BatchResult(custom_id=result.custom_id, response=None, error={"type": result.result.type}, usage=None))
        return results
