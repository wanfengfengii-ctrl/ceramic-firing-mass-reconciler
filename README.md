# 试烧窑批次核算站

浏览器分区录入领料、退料、成品、废料的多笔称重，FastAPI 以**十进制**完成批次闭合核算，
React 展示并由 **PostgreSQL** 保存每笔原始重量及当次判定，刷新后可随时复算。
窑边电子秤导出的称重明细（CSV）也可以直接导入：预检确认后替换当前录入，再按现有方式提交。

- 后端：Python 3.12 · FastAPI · SQLAlchemy 2（async）· PostgreSQL（psycopg 3）
- 前端：TypeScript · React 19 · Vite
- 测试：pytest（计算规则 + 真实 PostgreSQL 事务）· Vitest（十进制核算与组件）· Playwright（端到端）

## 单位与录入规则

- **所有重量的单位均为克（g）**，以十进制文本输入，最多三位小数，且必须**大于零**。
- JSON 中的重量一律是字符串（如 `"1200.500"`），不接受数字类型，二进制浮点不参与任何裁决。
- 同批退料总量不得大于领料总量。

### 单笔与成组两种称重行

窑边连续称量同规格匣钵/料桶时纸单常写作“单桶重量×桶数”，因此四个分区的每一行都可
切换为**成组录入**：

- 单笔行：直接提交一个重量字符串，如 `"1200.500"`；
- 成组行：提交对象 `{"mode": "group", "unit_weight": "12.500", "count": 8}`，
  其中 `unit_weight` 是单份克重（十进制字符串，规则同单笔），`count` 是 **2–999 的整数份数**。
  后端用十进制重算 `采用重量 = 单份重量 × 份数`（结果仍精确到三位小数），乘积与各合计均
  不得超过 `Numeric(14,3)` 上限 `99999999999.999` g；一个成组对象只保存为**一行**。
- 两种行可在同一分区、同一批次混用；份数越界、单份非法、乘积超范围或对象字段矛盾
  （缺字段、多字段、mode 不是 group）都返回 400，**整批回滚**，批次与称重行均不落库。
- 旧的纯字符串请求与旧数据库记录（成组依据列为 NULL）一律解释为单笔，行为不变。

## 称重文件导入（CSV 预检）

窑边电子秤导出的称重明细可一次带入当前录入页：页面选择文件后调用
`POST /api/batches/import-preview` 预检，合法行映射为现有的单笔/成组对象并给出
四分区核算预览；**确认前批次号与已手工填写的内容保持不动**，确认后四个分区被导入行
整体替换，再按现有方式核对预览并提交 `POST /api/batches` 保存。取消或预检失败都不
改变当前表单与最近一次核算详情。

文件格式（UTF-8，允许 BOM 与 CRLF）：

- 第一个非空行为表头，必须各含一次 `分区`、`重量`、`单份重量`、`份数` 四列；
  列序不限，允许额外列（忽略），表头名重复整份拒绝；
- 数据行按文件行序处理，分区列取 `领料/退料/成品/废料`（或英文键
  `issued/returned/product/scrap`）；同一分区的多行保持文件中的先后顺序；
- 单笔行只填 `重量`；成组行只填 `单份重量` 与 `份数`（2–999 的整数）——
  两种填法混填、缺一半或全空都属于字段矛盾；
- 全部单元格为空的行忽略（行号仍按原始文件物理行计数）。
- 引号按 RFC 4180 解析：引号字段可以包含逗号、CRLF 与换行（允许一条逻辑记录
  跨多个物理行），但引号必须成对且闭合后不得夹带多余字符；引号未闭合等格式
  损坏整份拒绝，绝不允许未闭合引号吞并其后的成品等记录而预检“成功”。
- 页面按 **UTF-8 严格解码**文件原始字节（`TextDecoder(..., { fatal: true })`）：
  含非法 UTF-8 字节时在浏览器侧即整份拒绝、不发预检请求，避免 `Blob.text()`/
  `readAsText` 把损坏字节静默替换成 U+FFFD 后仍通过预检；BOM 仍允许。

未知分区、重复表头、字段矛盾、引号格式损坏或任一重量/份数非法时**整份拒绝**，
返回 400 与 `{"detail", "line", "reason"}`（`line` 为该称重记录**开始的原始
物理行**——跨物理行的引号字段非法时指向记录起始行，而非字段结束行；文件级
错误为 `null`）；
预检只读不写库，非法文件零落库。

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
      "issued":   ["1000.000", {"mode": "group", "unit_weight": "12.500", "count": 8}],
      "returned": [{"mode": "group", "unit_weight": "10.000", "count": 5}],
      "product":  ["1395.000"],
      "scrap":    ["10.000"]
    }
  }
  ```
  每行可为单笔字符串或成组对象（见上节）；返回的 `entries` 中，成组行带
  `mode: "group"`、`unit_weight`、`count` 与乘出的 `weight`，单笔行 `mode: "single"`，
  旧记录无依据字段时同样按单笔显示。
  非法输入 400 且不留记录；批次号重复 409。
- `POST /api/batches/import-preview` — 称重文件导入预检（**不写数据库**）
  ```json
  { "content": "分区,重量,单份重量,份数\n领料,1000.000,,\n领料,,12.500,8\n成品,1095.000,,\n" }
  ```
  按文件行序解析表头与十进制字段，复用成组校验与四分区核算，返回规范化行
  （`entries`，与详情相同的行结构）和核算预览（`preview`：两侧合计、带符号差额、
  允许差、裁决）。空行忽略；未知分区、重复表头、字段矛盾、引号未闭合等格式
  损坏或任一重量非法时整份拒绝；页面另在浏览器侧以 UTF-8 严格解码拒绝编码
  无效的文件。返回 400 与
  `{"detail", "line", "reason"}`（`line` 为该记录开始的原始物理行号，文件级错误为
  `null`），供页面定位。用户在页面确认后，仍通过 `POST /api/batches` 提交保存。
- `GET /api/batches` — 已保存批次列表（含裁决快照）
- `GET /api/batches/{id}` — 可复算详情（原始行 + 两侧合计 + 差额 + 允许差 + 闭合/不闭合）
- `GET /api/batches/{id}/compare?base_id={基准id}` — 与基准批次并排核对（只读，不改批次或称重行）：
  返回双方身份与裁决快照，以及领料/退料/净投入/成品/废料/产出/差额/允许差各指标的
  双方值与带符号变化量（当前 − 基准，固定三位小数，正为增、负为减），并给出
  `verdict_changed` 标记裁决是否翻转。当前或基准批次不存在时 404 且指明角色与批次标识；
  基准与当前相同（自比）时 400（页面也会直接阻止该请求）。
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
