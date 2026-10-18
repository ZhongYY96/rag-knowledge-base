"""tokenwatch/selfhost.py — Self-hosting break-even calculator."""

from dataclasses import dataclass


@dataclass
class GPUInstance:
    name: str
    provider: str
    gpu_model: str
    gpu_count: int
    vram_gb: int
    hourly_cost: float
    tokens_per_second: int
    spot_discount_pct: float = 60.0


@dataclass
class SelfHostModel:
    name: str
    parameter_count: str
    vram_required_fp16_gb: float
    vram_required_int8_gb: float
    vram_required_int4_gb: float
    quality_score: float
    context_window: int


@dataclass
class BreakEvenAnalysis:
    managed_monthly_cost: float
    managed_cost_per_request: float
    gpu_instance: str
    gpu_monthly_cost: float
    operational_monthly_cost: float
    selfhost_monthly_total: float
    selfhost_cost_per_request: float
    savings_monthly: float
    savings_pct: float
    break_even_daily_requests: int
    recommendation: str
    quality_warning: str


def break_even_analysis(
    daily_requests: int, avg_input_tokens: int, avg_output_tokens: int,
    managed_input_rate: float, managed_output_rate: float,
    selfhost_model: SelfHostModel, gpu_instance: GPUInstance,
    engineering_hours_monthly: float = 40.0, engineering_hourly_rate: float = 100.0,
    use_spot: bool = False, quantization: str = "int8", redundancy_factor: float = 1.5,
    managed_model: str = "",
) -> BreakEvenAnalysis:
    monthly_requests = daily_requests * 30
    managed_monthly = (avg_input_tokens * monthly_requests / 1_000_000) * managed_input_rate + \
                      (avg_output_tokens * monthly_requests / 1_000_000) * managed_output_rate
    managed_per_req = managed_monthly / monthly_requests if monthly_requests > 0 else 0

    vram_map = {"fp16": selfhost_model.vram_required_fp16_gb, "int8": selfhost_model.vram_required_int8_gb, "int4": selfhost_model.vram_required_int4_gb}
    required_vram = vram_map.get(quantization, selfhost_model.vram_required_int8_gb)
    instances = max(1, int(required_vram / gpu_instance.vram_gb) + 1)
    instances = int(instances * redundancy_factor)
    hourly = gpu_instance.hourly_cost * (1 - gpu_instance.spot_discount_pct / 100 if use_spot else 1)
    gpu_monthly = instances * hourly * 24 * 30
    ops_monthly = engineering_hours_monthly * engineering_hourly_rate
    selfhost_total = gpu_monthly + ops_monthly
    selfhost_per_req = selfhost_total / monthly_requests if monthly_requests > 0 else 0
    savings = managed_monthly - selfhost_total
    savings_pct = (savings / managed_monthly * 100) if managed_monthly > 0 else 0
    be_daily = int(selfhost_total / (managed_per_req * 30)) if managed_per_req > 0 else 0
    quality_gap = 1.0 - selfhost_model.quality_score
    qw = f"Quality score: {selfhost_model.quality_score:.0%}" + (" — significant gap" if quality_gap > 0.3 else "")
    rec = f"Saves ${savings:,.0f}/month" if savings > 0 else f"Costs ${-savings:,.0f}/month MORE"

    return BreakEvenAnalysis(
        managed_monthly_cost=managed_monthly, managed_cost_per_request=managed_per_req,
        gpu_instance=gpu_instance.name, gpu_monthly_cost=gpu_monthly,
        operational_monthly_cost=ops_monthly, selfhost_monthly_total=selfhost_total,
        selfhost_cost_per_request=selfhost_per_req, savings_monthly=savings,
        savings_pct=savings_pct, break_even_daily_requests=be_daily,
        recommendation=rec, quality_warning=qw,
    )
