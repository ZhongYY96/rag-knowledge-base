"""tokenwatch/pipeline.py — Integrated request pipeline."""

import time
from dataclasses import dataclass, field
from typing import Any
import anthropic
from tokenwatch.config import TokenwatchConfig
from tokenwatch.middleware import TokenMeter
from tokenwatch.store import UsageStore
from tokenwatch.meter import UsageRecord
from tokenwatch.governance import BudgetManager, BudgetAction
from tokenwatch.quotas import QuotaManager
from tokenwatch.router import RoutingPolicy, RoutingDecision, Complexity
from tokenwatch.routing_engine import RoutingEngine
from tokenwatch.cache import CacheOptimizer
from tokenwatch.history import truncate_history
from tokenwatch.preflight import preflight_check


@dataclass
class PipelineResult:
    response: anthropic.types.Message
    usage: UsageRecord
    routing: RoutingDecision
    governance_action: str
    model_used: str
    cost_usd: float
    latency_ms: float
    cache_hit: bool
    warnings: list[str] = field(default_factory=list)


class TokenwatchPipeline:
    """The complete tokenwatch pipeline for production use."""

    def __init__(
        self, config: TokenwatchConfig, store: UsageStore | None = None,
        budget_manager: BudgetManager | None = None,
        quota_manager: QuotaManager | None = None,
        routing_policy: RoutingPolicy | None = None,
        client: anthropic.Anthropic | None = None,
        environment: str = "production",
    ):
        self.config = config
        self.store = store or UsageStore()
        self.client = client or anthropic.Anthropic()
        self.meter = TokenMeter(config, self.store, environment=environment)
        self.budget_manager = budget_manager or BudgetManager(self.store)
        self.quota_manager = quota_manager or QuotaManager()
        self.cache_optimizer = CacheOptimizer(config)
        self.routing_engine = RoutingEngine(
            config, routing_policy or RoutingPolicy.anthropic_cascade(),
            meter=self.meter, client=self.client,
        )

    def send(
        self, messages: list[dict], system: str = "", feature: str = "unknown",
        user_id: str = "", team: str = "unknown", max_tokens: int = 4096,
        tools: list[dict] | None = None, enable_cache: bool = True,
        enable_routing: bool = True, max_history_tokens: int = 8000, **kwargs,
    ) -> PipelineResult:
        warnings = []
        budget_result = self.budget_manager.check_budget(feature, team, 0.01)
        quota_ok, quota_msg = self.quota_manager.check_and_increment(feature, team)
        if not budget_result.allowed:
            raise RuntimeError(f"Blocked: {budget_result.message}")
        if not quota_ok:
            raise RuntimeError(f"Quota: {quota_msg}")

        model_override = budget_result.downgrade_model if budget_result.action == BudgetAction.DOWNGRADE else None
        governance_action = "DOWNGRADED" if model_override else "OK"

        if enable_routing and not model_override:
            decision = self.routing_engine.route(messages=messages, system=system, feature=feature, tool_count=len(tools or []))
            model = decision.model
        else:
            model = model_override or self.config.default_model
            decision = RoutingDecision(model=model, complexity=Complexity.MEDIUM, reason="Default", estimated_cost_ratio=1.0)

        optimized = truncate_history(messages, max_tokens=max_history_tokens)
        if enable_cache and system:
            cached = self.cache_optimizer.build_cached_messages(system_prompt=system, tool_definitions=tools, conversation_history=optimized)
            api_system, api_messages = cached["system"], cached["messages"]
        else:
            api_system, api_messages = system, optimized

        api_kwargs = {"model": model, "max_tokens": max_tokens, "system": api_system, "messages": api_messages}
        if tools:
            api_kwargs["tools"] = tools
        api_kwargs.update(kwargs)

        start = time.monotonic()
        response = self.client.messages.create(**api_kwargs)
        latency_ms = (time.monotonic() - start) * 1000
        record = self.meter.measure_anthropic(response, latency_ms, feature, user_id, team)
        cache_result = self.cache_optimizer.track_cache_result(response, model)

        return PipelineResult(
            response=response, usage=record, routing=decision,
            governance_action=governance_action, model_used=model,
            cost_usd=record.cost_usd, latency_ms=latency_ms,
            cache_hit=cache_result.get("cache_hit", False), warnings=warnings,
        )
