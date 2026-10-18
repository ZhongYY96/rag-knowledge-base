"""tokenwatch/agents.py — Agent cost controls and budget management."""

from dataclasses import dataclass, field


class AgentBudgetExceeded(Exception):
    def __init__(self, budget: float, spent: float, message: str = ""):
        self.budget = budget
        self.spent = spent
        super().__init__(message or f"Agent budget exceeded: ${spent:.4f} of ${budget:.4f}")


@dataclass
class AgentBudget:
    max_cost_usd: float = 1.0
    max_iterations: int = 15
    max_tool_calls: int = 20
    max_input_tokens: int = 100_000
    warn_at_pct: float = 0.7
    current_cost: float = 0.0
    current_iterations: int = 0
    current_tool_calls: int = 0
    current_input_tokens: int = 0
    warnings_issued: list[str] = field(default_factory=list)

    def check(self, additional_cost: float = 0.0) -> None:
        projected = self.current_cost + additional_cost
        if projected > self.max_cost_usd:
            raise AgentBudgetExceeded(self.max_cost_usd, projected, f"Cost limit exceeded")
        if self.current_iterations >= self.max_iterations:
            raise AgentBudgetExceeded(self.max_cost_usd, self.current_cost, f"Iteration limit")
        if self.current_tool_calls >= self.max_tool_calls:
            raise AgentBudgetExceeded(self.max_cost_usd, self.current_cost, f"Tool call limit")

    def record_iteration(self, cost: float, input_tokens: int, tool_calls: int = 0) -> None:
        self.current_cost += cost
        self.current_iterations += 1
        self.current_input_tokens += input_tokens
        self.current_tool_calls += tool_calls
        if self.current_cost > self.max_cost_usd * self.warn_at_pct:
            w = f"Budget warning: ${self.current_cost:.4f} spent ({self.current_cost/self.max_cost_usd*100:.0f}%)"
            if w not in self.warnings_issued:
                self.warnings_issued.append(w)

    @property
    def remaining_budget_usd(self) -> float:
        return max(0, self.max_cost_usd - self.current_cost)

    def summary(self) -> dict:
        return {
            "cost_spent": self.current_cost, "cost_limit": self.max_cost_usd,
            "iterations": self.current_iterations, "tool_calls": self.current_tool_calls,
            "warnings": self.warnings_issued,
        }
