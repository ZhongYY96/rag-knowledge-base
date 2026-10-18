"""运行配置：全部来自环境变量，带本地默认值。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent   # backend/
DATA_DIR = Path(os.environ.get("COST_DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("COST_DB", DATA_DIR / "cost.db"))
PRICING_PATH = Path(os.environ.get("COST_PRICING", BASE_DIR / "pricing.yaml"))

# 只在服务端使用；浏览器永远拿不到
INTERNAL_TOKEN = os.environ.get("COST_INTERNAL_TOKEN", "dev-internal-token")

# 降级映射：预算超限时建议客户端切换到哪个模型
DOWNGRADE_TARGET = os.environ.get("COST_DOWNGRADE_TARGET", "MiniCPM5-2B")
