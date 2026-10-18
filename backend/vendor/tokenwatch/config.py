"""tokenwatch/config.py — Configuration management for tokenwatch."""

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class ModelPricing:
    """Pricing for a single model. Rates are per million tokens."""
    model_id: str
    provider: str
    input_rate: float
    output_rate: float
    cached_rate: float = 0.0
    thinking_rate: float = 0.0
    batch_input_rate: float = 0.0
    batch_output_rate: float = 0.0

    def cost_for_tokens(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cached_tokens: int = 0,
        thinking_tokens: int = 0,
        batch: bool = False,
    ) -> float:
        """Calculate the cost for a given token breakdown."""
        if batch and self.batch_input_rate > 0:
            input_cost = (input_tokens / 1_000_000) * self.batch_input_rate
            output_cost = (output_tokens / 1_000_000) * self.batch_output_rate
        else:
            input_cost = (input_tokens / 1_000_000) * self.input_rate
            output_cost = (output_tokens / 1_000_000) * self.output_rate

        cached_cost = (cached_tokens / 1_000_000) * self.cached_rate
        thinking_cost = (thinking_tokens / 1_000_000) * self.thinking_rate

        return input_cost + output_cost + cached_cost + thinking_cost


@dataclass
class TokenwatchConfig:
    """Global configuration loaded from pricing.yaml."""
    models: dict[str, ModelPricing] = field(default_factory=dict)
    default_model: str = ""
    budget_alert_threshold_usd: float = 100.0
    budget_hard_limit_usd: float = 1000.0

    @classmethod
    def from_yaml(cls, path: str | Path) -> "TokenwatchConfig":
        """Load configuration from a YAML file."""
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(
                f"Pricing config not found: {path}. "
                "Copy pricing.example.yaml and update with current rates."
            )

        with open(path) as f:
            raw = yaml.safe_load(f)

        models = {}
        for model_data in raw.get("models", []):
            model = ModelPricing(
                model_id=model_data["model_id"],
                provider=model_data["provider"],
                input_rate=model_data["input_rate"],
                output_rate=model_data["output_rate"],
                cached_rate=model_data.get("cached_rate", 0.0),
                thinking_rate=model_data.get("thinking_rate", 0.0),
                batch_input_rate=model_data.get("batch_input_rate", 0.0),
                batch_output_rate=model_data.get("batch_output_rate", 0.0),
            )
            models[model.model_id] = model

        return cls(
            models=models,
            default_model=raw.get("default_model", ""),
            budget_alert_threshold_usd=raw.get("budget_alert_threshold_usd", 100.0),
            budget_hard_limit_usd=raw.get("budget_hard_limit_usd", 1000.0),
        )

    def get_model(self, model_id: str) -> ModelPricing:
        """Get pricing for a model, raising if not configured."""
        if model_id not in self.models:
            raise KeyError(
                f"Model '{model_id}' not found in pricing config. "
                f"Available: {list(self.models.keys())}"
            )
        return self.models[model_id]
