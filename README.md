# 试烧窑批次核算站

浏览器分区录入领料、退料、成品、废料的多笔称重，FastAPI 以**十进制**完成批次闭合核算，
React 展示并由 **PostgreSQL** 保存每笔原始重量及当次判定，刷新后可随时复算。

- 后端：Python 3.12 · FastAPI · SQLAlchemy 2（async）· PostgreSQL（psycopg 3）
- 前端：TypeScript · React 19 · Vite
- 测试：pytest（计算规则 + 真实 PostgreSQL 事务）· Vitest（十进制核算与组件）· Playwright（端到端）

## 单位与录入规则

- **所有重量的单位均为克（g）**，以十进制文本输入，最多三位小数，且必须**大于零**。
- JSON 中的重量一律是字符串（如 `"1200.500"`），不接受数字类型，二进制浮点不参与任何裁决。
- 同批退料总量不得大于领料总量。

## 快速启动（Docker Compose）

需要 Docker（含 Compose v2）。以下命令中的端口单位同样是普通 TCP 端口：

```bash
# 默认：Web 界面 http://localhost:8080 ，API http://localhost:8000
docker compose up --build
```

端口均可覆盖（`WEB_PORT` 为浏览器访问端口，`API_PORT` 为 FastAPI 端口）：

```bash
WEB_PORT=9090 API_PORT=9000 docker compose up --build
# 界面 http://localhost:9090 ，接口 http://localhost:9000
```

### 一次性验收服务 verify

`verify` 是**一次性**服务：它对正在运行的真实 web + api + PostgreSQL 跑全套 Playwright
端到端用例（四分区录入、闭合/不闭合裁决、非法批次整体拒绝不留记录、刷新后结果一致），
打印结果后退出，不提供常驻服务。

```bash
docker compose up --build -d            # 先起 db / api / web
docker compose run --build --rm verify  # 运行一次性验收，退出码即验收结论
docker compose down -v                  # 停止并清理数据卷
```

## 核算规则（单位：克）

| 项目 | 公式 |
| --- | --- |
| 净投入 | 领料合计 − 退料合计 |
| 产出 | 成品合计 + 废料合计 |
| 差额（带符号） | 产出 − 净投入 |
| 允许差 | max(5, ROUND_HALF_UP(净投入 × 0.2% 到整数克)) |
| 闭合判定 | &#124;差额&#124; ≤ 允许差 |

- 合计与差额保留三位小数；百分比结果按十进制 `ROUND_HALF_UP` 舍入到整数克。
- 后端全程使用 Python `decimal.Decimal`；前端预览用“毫克”整数（BigInt）放大计算，
  均不出现二进制浮点。
- **非法批次整体拒绝**：零/负数、超过三位小数、非十进制文本、退料大于领料等情况返回
  400，事务回滚，数据库中不留下批次或任何原始行。
- **合法但超差的批次照常保存**，详情显示“不闭合”；刷新页面后重新从 PostgreSQL 读取，
  业务结果完全一致。

详情页同时呈现：四个分区的原始称重行、投入侧/产出侧合计、带符号差额、允许差与裁决。

## HTTP 接口

- `POST /api/batches` — 提交批次
  ```json
  {
    "batch_no": "K2026-0912-03",
    "entries": {
      "issued":   ["1000.000", "500.000"],
      "returned": ["100.000"],
      "product":  ["1395.000"],
      "scrap":    ["10.000"]
    }
  }
  ```
  返回 201 与完整核算详情；非法输入 400 且不留记录；批次号重复 409。
- `GET /api/batches` — 已保存批次列表（含裁决快照）
- `GET /api/batches/{id}` — 可复算详情（原始行 + 两侧合计 + 差额 + 允许差 + 闭合/不闭合）
- `GET /healthz` — 健康检查

## 本地开发与测试

### 后端

需要一个可连接的 PostgreSQL 17（库内表由应用启动时自动创建）：

```bash
cd backend
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

# Unix socket 示例：
export DATABASE_URL='postgresql+psycopg://postgres@/kilntest?host=%2Ftmp'
uvicorn app.main:app --reload --port 8000
pytest                       # 计算规则 + 真实 PostgreSQL 事务/刷新复算测试
```

### 前端

```bash
cd frontend
npm install
npm run dev                  # http://localhost:5173 ，/api 代理到 :8000
npm test                     # Vitest：十进制核算与组件
npm run build                # 类型检查 + 生产构建
```

### 端到端（真实 FastAPI + PostgreSQL，禁止假接口）

先在 :8000 启动后端并设置好 `DATABASE_URL`，然后：

```bash
cd frontend
npx playwright install chromium   # 首次需要
npm run e2e                       # 自动 build 并起 vite preview，跑真实后端
```

CI/容器环境用上面的 `docker compose run --rm verify` 即可。

## 目录结构

```
backend/   FastAPI、十进制核算、SQLAlchemy 模型、pytest
frontend/  React/TS 界面、Vitest、Playwright、nginx 镜像
docker-compose.yml   db / api / web + 一次性 verify 服务
```
