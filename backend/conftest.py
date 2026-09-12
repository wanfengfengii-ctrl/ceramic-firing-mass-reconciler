"""必须在任何 app 模块导入之前确定数据库地址（引擎在导入时创建）。"""

import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql+psycopg://postgres@/kilntest?host=%2Ftmp"
)
