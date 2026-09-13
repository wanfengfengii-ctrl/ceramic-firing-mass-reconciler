import { expect, test, type Page } from "@playwright/test";

/**
 * 端到端验收：真实 FastAPI + PostgreSQL（禁止假接口）。
 * 用每个测试独有的批次号，保证重复运行不被唯一约束干扰。
 */

const stamp = Date.now();
let counter = 0;
const nextBatchNo = () => `E2E-${stamp}-${counter++}`;

async function fillRow(page: Page, kind: string, seq: number, value: string) {
  const input = page.getByLabel(`${kind}第${seq}笔重量（克）`);
  await input.fill(value);
}

async function switchRowToGroup(page: Page, kind: string, seq: number) {
  const panel = page.getByRole("region", { name: `${kind}分区` });
  await panel.getByRole("radio", { name: "成组" }).nth(seq - 1).check();
}

async function fillGroupRow(
  page: Page,
  kind: string,
  seq: number,
  unit: string,
  count: string,
) {
  await page.getByLabel(`${kind}第${seq}笔单份重量（克）`).fill(unit);
  await page.getByLabel(`${kind}第${seq}笔份数`).fill(count);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("健康检查与页面加载", async ({ page }) => {
  const health = await page.request.get("/healthz");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ status: "ok" });
  await expect(page.getByRole("heading", { name: "试烧窑批次核算站" })).toBeVisible();
});

test("四分区录入→保存→详情含原始行/两侧合计/带符号差额/允许差/闭合", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await fillRow(page, "领料", 1, "1000.000");
  await page.getByRole("button", { name: "+ 添加一笔领料" }).click();
  await fillRow(page, "领料", 2, "500.000");
  await fillRow(page, "退料", 1, "100.000");
  await fillRow(page, "成品", 1, "1395.000");
  await fillRow(page, "废料", 1, "10.000");

  // 本地十进制预览
  await expect(page.getByTestId("preview-difference")).toHaveText("+5.000 g");
  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：闭合");

  await page.getByTestId("submit").click();

  const detail = page.getByTestId("batch-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");
  await expect(page.getByTestId("detail-issued-total")).toHaveText("1500.000 g");
  await expect(page.getByTestId("detail-net")).toHaveText("1400.000 g");
  await expect(page.getByTestId("detail-difference")).toHaveText("+5.000 g");
  await expect(page.getByTestId("detail-tolerance")).toHaveText("5 g");

  const rawIssued = page.getByTestId("raw-issued");
  await expect(rawIssued).toContainText("第 1 笔：1000.000 g");
  await expect(rawIssued).toContainText("第 2 笔：500.000 g");
});

test("非法批次整体拒绝：页面报错、不出现详情、列表中无记录", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await fillRow(page, "领料", 1, "100.000");
  await fillRow(page, "退料", 1, "100.001"); // 退料大于领料

  await page.getByTestId("submit").click();

  const error = page.getByTestId("form-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("退料");
  await expect(page.getByTestId("batch-detail")).toHaveCount(0);

  // 直接查接口确认后端没有留下任何该批次记录
  const list = await page.request.get("/api/batches");
  const batches = (await list.json()) as Array<{ batch_no: string }>;
  expect(batches.find((b) => b.batch_no === no)).toBeUndefined();
});

test("合法但超差的批次照常保存并显示“不闭合”，刷新后结果不变", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  // 净投入 3000g，允许差 6g；产出 3010g，差额 +10g，超差
  await fillRow(page, "领料", 1, "3000.000");
  await fillRow(page, "成品", 1, "3010.000");

  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：不闭合");
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("batch-detail")).toBeVisible();
  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");
  await expect(page.getByTestId("detail-difference")).toHaveText("+10.000 g");
  await expect(page.getByTestId("detail-tolerance")).toHaveText("6 g");

  // 浏览器刷新：从 PostgreSQL 重新拉取，业务结果完全一致
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(no) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("+10.000");
  await expect(row).toContainText("不闭合");
  await row.getByRole("button", { name: "查看可复算详情" }).click();

  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");
  await expect(page.getByTestId("detail-difference")).toHaveText("+10.000 g");
  await expect(page.getByTestId("detail-tolerance")).toHaveText("6 g");
  await expect(page.getByTestId("raw-issued")).toContainText("第 1 笔：3000.000 g");
  await expect(page.getByTestId("raw-product")).toContainText("第 1 笔：3010.000 g");
});

test("单笔与成组行混合：即时乘法、小计/预览、保存后详情还原算式且裁决一致", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);

  // 领料第 1 笔为单笔 1000；第 2 笔切换为成组 12.5 × 8 = 100
  await fillRow(page, "领料", 1, "1000.000");
  await page.getByRole("button", { name: "+ 添加一笔领料" }).click();
  await switchRowToGroup(page, "领料", 2);
  await fillGroupRow(page, "领料", 2, "12.500", "8");

  // 十进制乘积即时显示，不出现 12.5*8 的二进制浮点尾巴
  await expect(page.getByTestId("adopted-issued-1")).toHaveText("= 100.000 g");
  await expect(page.getByTestId("subtotal-issued")).toHaveText("小计：1100.000 g");

  // 退料成组 10 × 5 = 50
  await switchRowToGroup(page, "退料", 1);
  await fillGroupRow(page, "退料", 1, "10.000", "5");
  await expect(page.getByTestId("subtotal-returned")).toHaveText("小计：50.000 g");

  // 产出侧仍用普通单笔行：成品 1040 + 废料 60 = 1100
  await fillRow(page, "成品", 1, "1040.000");
  await fillRow(page, "废料", 1, "60.000");

  // 预览：净投入 1050，产出 1100，差额 +50，允许差 5 → 不闭合
  await expect(page.getByTestId("preview-difference")).toHaveText("+50.000 g");
  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：不闭合");

  await page.getByTestId("submit").click();

  // 保存后详情与预览裁决一致，成组行还原算式
  const detail = page.getByTestId("batch-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");
  await expect(page.getByTestId("detail-issued-total")).toHaveText("1100.000 g");
  await expect(page.getByTestId("detail-net")).toHaveText("1050.000 g");
  await expect(page.getByTestId("detail-difference")).toHaveText("+50.000 g");

  const rawIssued = page.getByTestId("raw-issued");
  await expect(rawIssued).toContainText("第 1 笔：1000.000 g");
  const groupLine = page.getByTestId("raw-issued-2-group");
  await expect(groupLine).toHaveText("第 2 笔：12.500 g × 8 桶 = 100.000 g");
  await expect(page.getByTestId("raw-returned")).toContainText(
    "第 1 笔：10.000 g × 5 桶 = 50.000 g",
  );

  // 刷新详情：算式依据仍在，裁决不变
  await page.reload();
  const histRow = page.getByRole("row", { name: new RegExp(no) });
  await histRow.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");
  await expect(page.getByTestId("raw-issued-2-group")).toContainText(
    "12.500 g × 8 桶 = 100.000 g",
  );
});

test("成组份数越界：页面定位到对应分区和行，请求被本地拦截且整批不落库", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await fillRow(page, "领料", 1, "1000.000");
  await switchRowToGroup(page, "成品", 1);
  await fillGroupRow(page, "成品", 1, "12.500", "1000"); // 份数 > 999

  // 行内即时提示与预览都定位到“成品 第 1 笔”
  await expect(page.getByTestId("adopted-product-0")).toContainText("份数");
  await expect(page.locator(".panel-result .invalid")).toContainText("成品 第 1 笔");

  // 监听：非法批次不应发出 POST
  const postRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/batches")) postRequests.push(req.url());
  });

  await page.getByTestId("submit").click();
  const error = page.getByTestId("form-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveText("成品 第 1 笔：份数必须在 2 与 999 之间");
  await expect(page.getByTestId("batch-detail")).toHaveCount(0);
  expect(postRequests).toEqual([]);

  const list = await page.request.get("/api/batches");
  const batches = (await list.json()) as Array<{ batch_no: string }>;
  expect(batches.find((b) => b.batch_no === no)).toBeUndefined();
});

test("成组乘积越过存储精度边界：本地与后端一致拒绝，非法数据整体回滚", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await switchRowToGroup(page, "领料", 1);
  // 单份合法，乘积 100000000000.000 g 超过 Numeric(14,3) 上限 99999999999.999
  await fillGroupRow(page, "领料", 1, "50000000000.000", "2");
  await expect(page.getByTestId("adopted-issued-0")).toContainText("存储范围");
  await expect(page.locator(".panel-result .invalid")).toContainText("领料 第 1 笔");

  // 前端拦截后直接打后端：服务端同样整批 400 拒绝，不留批次
  const resp = await page.request.post("/api/batches", {
    data: {
      batch_no: no,
      entries: { issued: [{ mode: "group", unit_weight: "50000000000.000", count: 2 }] },
    },
  });
  expect(resp.status()).toBe(400);
  const body = await resp.json();
  expect(body.detail).toContain("存储范围");

  const list = await page.request.get("/api/batches");
  const batches = (await list.json()) as Array<{ batch_no: string }>;
  expect(batches.find((b) => b.batch_no === no)).toBeUndefined();
});

test("乘积刚好达到精度边界：前后端十进制结果相同（33333333333.333 × 3）", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await switchRowToGroup(page, "领料", 1);
  await fillGroupRow(page, "领料", 1, "33333333333.333", "3");
  // 采用重量恰好等于上限，本地预览接受该值
  await expect(page.getByTestId("adopted-issued-0")).toHaveText("= 99999999999.999 g");

  // 同值成品对抵，使批次闭合，验证整条链路前后端十进制结果一致
  await switchRowToGroup(page, "成品", 1);
  await fillGroupRow(page, "成品", 1, "33333333333.333", "3");
  await expect(page.getByTestId("preview-difference")).toHaveText("+0.000 g");
  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：闭合");

  await page.getByTestId("submit").click();
  await expect(page.getByTestId("batch-detail")).toBeVisible();
  await expect(page.getByTestId("detail-issued-total")).toHaveText("99999999999.999 g");
  await expect(page.getByTestId("detail-difference")).toHaveText("+0.000 g");
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");
  await expect(page.getByTestId("raw-issued-1-group")).toHaveText(
    "第 1 笔：33333333333.333 g × 3 桶 = 99999999999.999 g",
  );
});

test("成组单份指数极大时页面不卡死：立即在该行提示重量非法并可继续操作", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await fillRow(page, "领料", 1, "1000.000");
  await switchRowToGroup(page, "成品", 1);

  // 超大指数（旧实现会进入约 10 亿次 BigInt 乘法把页面卡死）
  const unit = page.getByLabel("成品第1笔单份重量（克）");
  await unit.fill("1e999999999");

  // 行内立即提示，小计保持不可核算，预览定位到该分区该行
  await expect(page.getByTestId("adopted-product-0")).toContainText("数量级超出存储范围");
  await expect(page.getByTestId("subtotal-product")).toHaveText("小计：—");
  await expect(page.locator(".panel-result .invalid")).toContainText("成品 第 1 笔");

  // 超长指数串（Number() 会得到 Infinity）同样立即拒绝
  await unit.fill("1e" + "9".repeat(20));
  await expect(page.getByTestId("adopted-product-0")).toContainText("数量级超出存储范围");

  // 页面仍然响应：改回合法值后即时恢复乘积与预览
  await unit.fill("12.500");
  await page.getByLabel("成品第1笔份数").fill("8");
  await expect(page.getByTestId("adopted-product-0")).toHaveText("= 100.000 g");
  await expect(page.getByTestId("subtotal-product")).toHaveText("小计：100.000 g");
  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：不闭合");
});

test("产出合计超限：领料取上限、成品废料各六百亿克，整批校验拒绝而非保存阶段异常", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await fillRow(page, "领料", 1, "99999999999.999");
  await fillRow(page, "成品", 1, "60000000000");
  await fillRow(page, "废料", 1, "60000000000");

  // 预览即提示产出合计超限、无法核算
  await expect(page.locator(".panel-result .invalid")).toContainText("产出合计");

  // 页面整批校验拦截：不发出 POST
  const postRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/batches")) postRequests.push(req.url());
  });
  await page.getByTestId("submit").click();
  const error = page.getByTestId("form-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("产出合计 120000000000.000 g 超出存储范围");
  await expect(page.getByTestId("batch-detail")).toHaveCount(0);
  expect(postRequests).toEqual([]);

  // 直接打后端：同样在整批校验时 400 拒绝（不是保存阶段的 500），不留记录
  const resp = await page.request.post("/api/batches", {
    data: {
      batch_no: no,
      entries: {
        issued: ["99999999999.999"],
        product: ["60000000000.000"],
        scrap: ["60000000000.000"],
      },
    },
  });
  expect(resp.status()).toBe(400);
  expect((await resp.json()).detail).toContain("产出合计");

  const list = await page.request.get("/api/batches");
  const batches = (await list.json()) as Array<{ batch_no: string }>;
  expect(batches.find((b) => b.batch_no === no)).toBeUndefined();
});

test("领料首行空白、第二行份数越界：提示行号与界面行号一致并定位第二行", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  // 第一行保留空白，第二行录入越界成组份数
  await page.getByRole("button", { name: "+ 添加一笔领料" }).click();
  await switchRowToGroup(page, "领料", 2);
  await fillGroupRow(page, "领料", 2, "12.500", "1000");

  await page.getByTestId("submit").click();
  const error = page.getByTestId("form-error");
  // 提示“第 2 笔”与界面行标签一致，并聚焦第二行的份数输入
  await expect(error).toHaveText("领料 第 2 笔：份数必须在 2 与 999 之间");
  await expect(page.getByLabel("领料第2笔份数")).toBeFocused();
});

test("同一非法成组行不修改再次提交：每次都重新聚焦对应输入", async ({ page }) => {
  const no = nextBatchNo();
  await page.getByTestId("batch-no").fill(no);
  await switchRowToGroup(page, "领料", 1);
  await fillGroupRow(page, "领料", 1, "12.500", "1000");

  const count = page.getByLabel("领料第1笔份数");
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("form-error")).toHaveText(
    "领料 第 1 笔：份数必须在 2 与 999 之间",
  );
  await expect(count).toBeFocused();

  // 不修改任何输入，焦点移走后再次提交：仍重新聚焦份数输入
  await page.getByTestId("batch-no").click();
  await expect(count).not.toBeFocused();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("form-error")).toHaveText(
    "领料 第 1 笔：份数必须在 2 与 999 之间",
  );
  await expect(count).toBeFocused();
});

test("批次对比：闭合与不闭合互比、反向符号相反、自比阻止、刷新后重新对比", async ({ page }) => {
  // 经真实 API 准备两个批次：A 闭合（差额 +5，允许差 5），B 不闭合（差额 +10，允许差 6）
  const noA = nextBatchNo();
  const noB = nextBatchNo();
  const respA = await page.request.post("/api/batches", {
    data: { batch_no: noA, entries: { issued: ["1000.000"], product: ["1005.000"] } },
  });
  expect(respA.status()).toBe(201);
  const respB = await page.request.post("/api/batches", {
    data: { batch_no: noB, entries: { issued: ["3000.000"], product: ["3010.000"] } },
  });
  expect(respB.status()).toBe(201);

  // 打开 B 的详情，选择 A 为基准并发起对比
  await page.goto("/");
  const rowB = page.getByRole("row", { name: new RegExp(noB) });
  await rowB.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");

  await page.getByTestId("compare-base-select").selectOption({ label: `${noA}（闭合）` });
  await page.getByTestId("compare-run").click();

  // 基准摘要、裁决变化与带符号差异（当前 B − 基准 A）
  await expect(page.getByTestId("compare-base-summary")).toContainText(noB);
  await expect(page.getByTestId("compare-base-summary")).toContainText(noA);
  await expect(page.getByTestId("compare-verdict-change")).toContainText("闭合 → 不闭合");
  await expect(page.getByTestId("compare-delta-net_input")).toHaveText("+2000.000 g");
  await expect(page.getByTestId("compare-delta-difference")).toHaveText("+5.000 g");
  await expect(page.getByTestId("compare-delta-tolerance")).toHaveText("+1.000 g");
  await expect(page.getByTestId("compare-delta-scrap_total")).toHaveText("+0.000 g");

  // 反向互换基准：打开 A 的详情对比 B，差值符号严格相反
  const rowA = page.getByRole("row", { name: new RegExp(noA) });
  await rowA.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");
  await page.getByTestId("compare-base-select").selectOption({ label: `${noB}（不闭合）` });
  await page.getByTestId("compare-run").click();
  await expect(page.getByTestId("compare-delta-net_input")).toHaveText("-2000.000 g");
  await expect(page.getByTestId("compare-delta-difference")).toHaveText("-5.000 g");
  await expect(page.getByTestId("compare-delta-tolerance")).toHaveText("-1.000 g");
  await expect(page.getByTestId("compare-verdict-change")).toContainText("不闭合 → 闭合");

  // 选择自身作为基准：页面阻止，不发出对比请求
  const compareRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/compare")) compareRequests.push(req.url());
  });
  await page.getByTestId("compare-base-select").selectOption({ label: `${noA}（闭合）` });
  await page.getByTestId("compare-run").click();
  await expect(page.getByTestId("compare-error")).toContainText("自身");
  expect(compareRequests).toEqual([]);
  // 详情保持打开
  await expect(page.getByTestId("batch-detail")).toBeVisible();

  // 刷新后重新打开详情并重新对比：结果与刷新前一致
  await page.reload();
  const rowAAfter = page.getByRole("row", { name: new RegExp(noA) });
  await rowAAfter.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");
  await page.getByTestId("compare-base-select").selectOption({ label: `${noB}（不闭合）` });
  await page.getByTestId("compare-run").click();
  await expect(page.getByTestId("compare-delta-net_input")).toHaveText("-2000.000 g");
  await expect(page.getByTestId("compare-delta-difference")).toHaveText("-5.000 g");
  await expect(page.getByTestId("compare-verdict-change")).toContainText("不闭合 → 闭合");
});

// ---------------------------------------------------------------------------
// 称重文件导入：预检 → 确认替换 → 现有方式提交保存；失败/取消不动当前内容
// ---------------------------------------------------------------------------

/** 通过隐藏的文件输入框选择一份 CSV（内容在内存中构造，不落临时文件）。 */
async function uploadCsv(page: Page, name: string, content: string) {
  await page.getByTestId("import-file").setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(content, "utf-8"),
  });
}

const MIXED_CSV = [
  "分区,重量,单份重量,份数",
  "领料,1000.000,,",
  "领料,,12.500,8",
  "退料,,10.000,5",
  "成品,1040.000,,",
  "废料,60.000,,",
].join("\n");

test("导入混合单笔与成组文件：预览、确认替换、保存与刷新详情一致", async ({ page }) => {
  const no = nextBatchNo();
  // 先手工填写批次号与一笔将被替换的内容，验证确认前不被动、确认后被替换
  await page.getByTestId("batch-no").fill(no);
  await fillRow(page, "成品", 1, "777.000");

  await uploadCsv(page, "weigh-mixed.csv", MIXED_CSV);

  // 预检面板：规范化行（含成组算式）与核算预览；手工内容尚未被替换
  const preview = page.getByTestId("import-preview");
  await expect(preview).toBeVisible();
  await expect(page.getByTestId("import-raw-issued-2-group")).toHaveText(
    "第 2 笔：12.500 g × 8 桶 = 100.000 g",
  );
  await expect(page.getByTestId("import-preview-issued")).toHaveText("1100.000 g");
  await expect(page.getByTestId("import-preview-net")).toHaveText("1050.000 g");
  await expect(page.getByTestId("import-preview-difference")).toHaveText("+50.000 g");
  await expect(page.getByTestId("import-preview-verdict")).toHaveText("预览裁决：不闭合");
  await expect(page.getByLabel("成品第1笔重量（克）")).toHaveValue("777.000");

  // 确认导入：批次号保留，四个分区被导入行整体替换
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-preview")).toHaveCount(0);
  await expect(page.getByTestId("batch-no")).toHaveValue(no);
  await expect(page.getByLabel("领料第1笔重量（克）")).toHaveValue("1000.000");
  await expect(page.getByLabel("领料第2笔单份重量（克）")).toHaveValue("12.500");
  await expect(page.getByLabel("领料第2笔份数")).toHaveValue("8");
  await expect(page.getByLabel("退料第1笔单份重量（克）")).toHaveValue("10.000");
  await expect(page.getByLabel("成品第1笔重量（克）")).toHaveValue("1040.000");
  await expect(page.getByLabel("废料第1笔重量（克）")).toHaveValue("60.000");

  // 现有本地预览即时反映导入内容，按现有方式提交保存
  await expect(page.getByTestId("preview-difference")).toHaveText("+50.000 g");
  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：不闭合");
  await page.getByTestId("submit").click();

  const detail = page.getByTestId("batch-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");
  await expect(page.getByTestId("detail-issued-total")).toHaveText("1100.000 g");
  await expect(page.getByTestId("detail-net")).toHaveText("1050.000 g");
  await expect(page.getByTestId("detail-difference")).toHaveText("+50.000 g");
  await expect(page.getByTestId("raw-issued-2-group")).toHaveText(
    "第 2 笔：12.500 g × 8 桶 = 100.000 g",
  );

  // 刷新后重新打开详情：与保存时完全一致
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(no) });
  await row.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("不闭合");
  await expect(page.getByTestId("detail-issued-total")).toHaveText("1100.000 g");
  await expect(page.getByTestId("detail-difference")).toHaveText("+50.000 g");
  await expect(page.getByTestId("raw-issued-2-group")).toHaveText(
    "第 2 笔：12.500 g × 8 桶 = 100.000 g",
  );
  await expect(page.getByTestId("raw-returned")).toContainText(
    "第 1 笔：10.000 g × 5 桶 = 50.000 g",
  );
});

test("乱序四分区的文件：各分区行序按文件顺序保留", async ({ page }) => {
  const no = nextBatchNo();
  const shuffled = [
    "分区,重量,单份重量,份数",
    "成品,100.000,,",
    "领料,500.000,,",
    "废料,10.000,,",
    "领料,600.000,,",
    "成品,200.000,,",
    "退料,50.000,,",
  ].join("\n");

  await uploadCsv(page, "weigh-shuffled.csv", shuffled);
  await page.getByTestId("import-confirm").click();
  await page.getByTestId("batch-no").fill(no);
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("batch-detail")).toBeVisible();
  // 每个分区内部的行序与文件中出现顺序一致
  await expect(page.getByTestId("raw-issued")).toContainText("第 1 笔：500.000 g");
  await expect(page.getByTestId("raw-issued")).toContainText("第 2 笔：600.000 g");
  await expect(page.getByTestId("raw-product")).toContainText("第 1 笔：100.000 g");
  await expect(page.getByTestId("raw-product")).toContainText("第 2 笔：200.000 g");
  await expect(page.getByTestId("raw-scrap")).toContainText("第 1 笔：10.000 g");
  await expect(page.getByTestId("raw-returned")).toContainText("第 1 笔：50.000 g");

  // 刷新详情后行序不变
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(no) });
  await row.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("raw-issued")).toContainText("第 1 笔：500.000 g");
  await expect(page.getByTestId("raw-issued")).toContainText("第 2 笔：600.000 g");
  await expect(page.getByTestId("raw-product")).toContainText("第 2 笔：200.000 g");
});

test("非法文件：错误精确指向原始行号、零落库、当前表单与最近详情均不丢失", async ({ page }) => {
  // 先保存一个合法批次并打开其详情（最近一次核算详情）
  const savedNo = nextBatchNo();
  const created = await page.request.post("/api/batches", {
    data: { batch_no: savedNo, entries: { issued: ["1000.000"], product: ["1005.000"] } },
  });
  expect(created.status()).toBe(201);

  await page.goto("/");
  const savedRow = page.getByRole("row", { name: new RegExp(savedNo) });
  await savedRow.getByRole("button", { name: "查看可复算详情" }).click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");

  // 手工填写内容：预检失败时必须原样保留
  await page.getByTestId("batch-no").fill("MANUAL-KEEP");
  await fillRow(page, "领料", 1, "123.456");

  // 导入前的批次列表快照（用于证明零落库）
  const before = (await (await page.request.get("/api/batches")).json()) as Array<{
    batch_no: string;
  }>;

  // 表头第 1 行、空行第 3 行：非法重量在原始文件第 4 行
  const badCsv = [
    "分区,重量,单份重量,份数",
    "领料,1000.000,,",
    "",
    "成品,abc,,",
  ].join("\n");
  await uploadCsv(page, "weigh-bad.csv", badCsv);

  const error = page.getByTestId("import-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("第 4 行");
  await expect(error).toContainText("无法识别");
  await expect(page.getByTestId("import-preview")).toHaveCount(0);

  // 表单与最近一次核算详情均不丢失
  await expect(page.getByLabel("领料第1笔重量（克）")).toHaveValue("123.456");
  await expect(page.getByTestId("batch-no")).toHaveValue("MANUAL-KEEP");
  await expect(page.getByTestId("batch-detail")).toBeVisible();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");

  // 零落库：批次列表与导入前完全一致
  const after = (await (await page.request.get("/api/batches")).json()) as Array<{
    batch_no: string;
  }>;
  expect(after).toEqual(before);
});

test("取消导入：待替换方案被丢弃，手工内容不变", async ({ page }) => {
  await page.getByTestId("batch-no").fill("MANUAL-1");
  await fillRow(page, "领料", 1, "123.456");
  await fillRow(page, "成品", 1, "120.000");

  await uploadCsv(page, "weigh-mixed.csv", MIXED_CSV);
  await expect(page.getByTestId("import-preview")).toBeVisible();

  await page.getByTestId("import-cancel").click();
  await expect(page.getByTestId("import-preview")).toHaveCount(0);

  // 手工内容（批次号 + 各分区行）原样保留，本地预览仍按手工内容核算
  await expect(page.getByTestId("batch-no")).toHaveValue("MANUAL-1");
  await expect(page.getByLabel("领料第1笔重量（克）")).toHaveValue("123.456");
  await expect(page.getByLabel("成品第1笔重量（克）")).toHaveValue("120.000");
  await expect(page.getByTestId("preview-difference")).toHaveText("-3.456 g");
});

test("备注列引号未闭合且其后还有成品称重：整份拒绝并指向引号开始行", async ({ page }) => {
  // 回归：宽松解析时未闭合引号会吞并后续成品/废料行，预检“成功”但成品记录消失。
  // strict 解析必须整份拒绝，行号指向引号开始的第 2 行。
  const csv = [
    "分区,重量,单份重量,份数,备注",
    '领料,1000.000,,,"坏备注未闭合',
    "成品,500.000,,,",
    "废料,10.000,,,",
  ].join("\n");

  const before = (await (await page.request.get("/api/batches")).json()) as unknown[];
  await uploadCsv(page, "weigh-unclosed.csv", csv);

  const error = page.getByTestId("import-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("第 2 行");
  await expect(error).toContainText("引号");
  await expect(page.getByTestId("import-preview")).toHaveCount(0);

  // 零落库
  const after = (await (await page.request.get("/api/batches")).json()) as unknown[];
  expect(after).toEqual(before);
});

test("重量字段跨行且拼接非法：错误标出该称重记录开始的原始行", async ({ page }) => {
  // 领料重量被引号包裹跨越第 2–3 物理行，拼接结果 "10\n0x" 非法；
  // 页面收到的行号必须是记录开始的第 2 行，而非字段结束的第 3 行
  const csv = ['分区,重量,单份重量,份数', '领料,"10', '0x",,', "成品,100.000,,"].join(
    "\n",
  );

  await uploadCsv(page, "weigh-multiline.csv", csv);

  const error = page.getByTestId("import-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("第 2 行");
  await expect(page.getByTestId("import-preview")).toHaveCount(0);
});

test("合法跨行引号字段仍可导入，后续成品行不丢失", async ({ page }) => {
  // 引号成对的跨行备注是合法 CSV：成品行必须保留，行号按物理行连续
  const no = nextBatchNo();
  const csv = [
    "分区,重量,单份重量,份数,备注",
    '领料,1000.000,,,"多行',
    '备注"',
    "成品,1000.000,,,",
  ].join("\n");

  await uploadCsv(page, "weigh-multiline-ok.csv", csv);
  const preview = page.getByTestId("import-preview");
  await expect(preview).toBeVisible();
  await expect(page.getByTestId("import-raw-product")).toContainText("第 1 笔：1000.000 g");

  await page.getByTestId("import-confirm").click();
  await page.getByTestId("batch-no").fill(no);
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("batch-detail")).toBeVisible();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");
});

test("文件含非法 UTF-8 字节：浏览器侧识别编码无效并整份拒绝，不发预检请求", async ({ page }) => {
  // 附加列含非法 UTF-8 字节（0xC3 后直接 ASCII 0x28）：
  // Blob.text()/readAsText 会静默替换成 U+FFFD 后照常通过预检；
  // 严格解码必须在浏览器侧整份拒绝
  const validPrefix = Buffer.from(
    ["分区,重量,单份重量,份数,备注", "领料,1000.000,,,,坏字节"].join("\n"),
    "utf-8",
  );
  const bytes = Buffer.concat([validPrefix, Buffer.from([0xc3, 0x28])]);

  let previewRequested = false;
  await page.route("**/api/batches/import-preview", async (route) => {
    previewRequested = true;
    await route.continue();
  });

  const before = (await (await page.request.get("/api/batches")).json()) as unknown[];
  await page.getByTestId("import-file").setInputFiles({
    name: "weigh-bad-utf8.csv",
    mimeType: "text/csv",
    buffer: bytes,
  });

  const error = page.getByTestId("import-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("UTF-8");
  await expect(page.getByTestId("import-preview")).toHaveCount(0);
  expect(previewRequested).toBe(false);

  const after = (await (await page.request.get("/api/batches")).json()) as unknown[];
  expect(after).toEqual(before);
});

test("第 2 行含超长重量的文件：页面指出该行重量非法，而非笼统重试", async ({ page }) => {  // 回归：约 1 MB 的超长重量曾让后端 500，页面只显示“请求失败/请重试”
  const longWeight = "9".repeat(999_900);
  const csv = [
    "分区,重量,单份重量,份数",
    `领料,${longWeight},,`,
    "成品,1,,",
  ].join("\n");

  // 手工内容在预检失败时必须保留
  await fillRow(page, "领料", 1, "123.456");
  // 零落库：导入前后批次列表完全一致
  const before = (await (await page.request.get("/api/batches")).json()) as unknown[];
  await uploadCsv(page, "weigh-long.csv", csv);

  const error = page.getByTestId("import-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("第 2 行");
  await expect(error).toContainText("重量");
  await expect(error).not.toContainText("请重试");
  await expect(error).not.toContainText("500");
  await expect(page.getByTestId("import-preview")).toHaveCount(0);
  await expect(page.getByLabel("领料第1笔重量（克）")).toHaveValue("123.456");

  const after = (await (await page.request.get("/api/batches")).json()) as unknown[];
  expect(after).toEqual(before);
});


// ---------------------------------------------------------------------------
// 日常秤检工作台：即时偏差/结论、保存、刷新恢复、临界与单点超差、非法/重复不留痕
// 秤检是独立资源：与批次接口互不引用、不阻断批次核算
// ---------------------------------------------------------------------------

const scaleStamp = Date.now();
let scaleCounter = 0;
const nextDeviceNo = () => `E2E-SC-${scaleStamp}-${scaleCounter++}`;

async function gotoScale(page: Page) {
  await page.goto("/");
  await page.getByTestId("tab-scale").click();
  await expect(page.getByTestId("scale-workbench")).toBeVisible();
}

async function fillScalePoint(page: Page, seq: number, standard: string, measured: string) {
  await page.getByLabel(`第${seq}测点标准重量（克）`).fill(standard);
  await page.getByLabel(`第${seq}测点实测重量（克）`).fill(measured);
}

async function scaleCount(page: Page): Promise<number> {
  const resp = await page.request.get("/api/scale-checks");
  const body = (await resp.json()) as unknown[];
  return body.length;
}

test("秤检：三组带符号偏差即时显示，合格保存并展示本次结论，刷新后台账倒序恢复", async ({ page }) => {
  const device = nextDeviceNo();
  await gotoScale(page);
  await page.getByTestId("scale-device").fill(device);
  await page.getByTestId("scale-date").fill("2026-09-13");
  await fillScalePoint(page, 1, "1000.000", "1000.100");
  await fillScalePoint(page, 2, "500.000", "499.600");
  await fillScalePoint(page, 3, "200.000", "200.300");

  // 即时带符号偏差（十进制定点，无二进制浮点尾巴）
  await expect(page.getByTestId("scale-deviation-0")).toHaveText("+0.100 g");
  await expect(page.getByTestId("scale-deviation-1")).toHaveText("-0.400 g");
  await expect(page.getByTestId("scale-deviation-2")).toHaveText("+0.300 g");
  await expect(page.getByTestId("scale-preview-verdict")).toHaveText("即时判定：合格");

  await page.getByTestId("scale-submit").click();

  const saved = page.getByTestId("scale-saved");
  await expect(saved).toBeVisible();
  await expect(page.getByTestId("scale-saved-verdict")).toHaveText("合格");
  await expect(saved).toContainText("+0.100");
  await expect(saved).toContainText("-0.400");

  // 台账出现该记录
  const row = page.locator('[data-testid^="scale-row-"]').filter({ hasText: device }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("2026-09-13");
  await expect(row).toContainText("合格");

  // 刷新工作台：通过同一资源查询契约恢复记录
  await page.reload();
  await page.getByTestId("tab-scale").click();
  const restored = page.getByRole("row").filter({ hasText: device }).first();
  await expect(restored).toBeVisible();
  await expect(restored).toContainText("+0.100 / -0.400 / +0.300");
  await expect(restored).toContainText("合格");

  // 接口契约与页面一致
  const list = await (await page.request.get("/api/scale-checks")).json() as Array<{
    device_no: string;
    check_date: string;
    passed: boolean;
    verdict: string;
    points: Array<{ deviation: string }>;
  }>;
  const mine = list.find((r) => r.device_no === device);
  expect(mine).toBeDefined();
  expect(mine!.check_date).toBe("2026-09-13");
  expect(mine!.passed).toBe(true);
  expect(mine!.verdict).toBe("合格");
  expect(mine!.points.map((p) => p.deviation)).toEqual(["+0.100", "-0.400", "+0.300"]);
});

test("秤检临界偏差：±0.500 g 合格，单点 +0.501/-0.501 g 不合格，前后端结论一致", async ({ page }) => {
  const deviceEdge = nextDeviceNo();
  await gotoScale(page);
  await page.getByTestId("scale-device").fill(deviceEdge);
  await page.getByTestId("scale-date").fill("2026-09-12");
  // 三组都恰好 ±0.500 g：临界合格
  await fillScalePoint(page, 1, "100.000", "100.500");
  await fillScalePoint(page, 2, "100.000", "99.500");
  await fillScalePoint(page, 3, "100.000", "100.000");
  await expect(page.getByTestId("scale-preview-verdict")).toHaveText("即时判定：合格");
  await page.getByTestId("scale-submit").click();
  await expect(page.getByTestId("scale-saved-verdict")).toHaveText("合格");

  // 接口裁决与预览一致
  const edgeList = (await (await page.request.get("/api/scale-checks")).json()) as Array<{
    device_no: string;
    passed: boolean;
  }>;
  expect(edgeList.find((r) => r.device_no === deviceEdge)?.passed).toBe(true);

  // 单点正向超差 +0.501
  const deviceOver = nextDeviceNo();
  await gotoScale(page);
  await page.getByTestId("scale-device").fill(deviceOver);
  await page.getByTestId("scale-date").fill("2026-09-12");
  await fillScalePoint(page, 1, "100.000", "100.500");
  await fillScalePoint(page, 2, "100.000", "99.500");
  await fillScalePoint(page, 3, "100.000", "100.501");
  await expect(page.getByTestId("scale-deviation-2")).toHaveText("+0.501 g");
  await expect(page.getByTestId("scale-preview-verdict")).toHaveText("即时判定：不合格");
  await page.getByTestId("scale-submit").click();
  await expect(page.getByTestId("scale-saved-verdict")).toHaveText("不合格");

  // 单点负向超差 -0.501（实测 99.499）直接打后端，结论同样不合格
  const deviceUnder = nextDeviceNo();
  const resp = await page.request.post("/api/scale-checks", {
    data: {
      device_no: deviceUnder,
      check_date: "2026-09-12",
      points: [
        { standard: "100.000", measured: "100.000" },
        { standard: "100.000", measured: "100.000" },
        { standard: "100.000", measured: "99.499" },
      ],
    },
  });
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  expect(body.passed).toBe(false);
  expect(body.verdict).toBe("不合格");
  expect(body.points[2].deviation).toBe("-0.501");

  // 台账按日期倒序、同日按保存先后倒序：只比较本次三条记录的相对次序
  const order = (await (await page.request.get("/api/scale-checks")).json()) as Array<{
    device_no: string;
    check_date: string;
  }>;
  const mine = order.filter((r) =>
    [deviceUnder, deviceOver, deviceEdge].includes(r.device_no),
  );
  expect(mine.map((r) => r.device_no)).toEqual([deviceUnder, deviceOver, deviceEdge]);
});

test("秤检非法字段：逐测点反馈、保留输入、不发请求、台账数量不变", async ({ page }) => {
  const before = await scaleCount(page);
  const device = nextDeviceNo();
  await gotoScale(page);
  await page.getByTestId("scale-device").fill(device);
  await page.getByTestId("scale-date").fill("2026-09-13");
  await fillScalePoint(page, 1, "0", "100");        // 标准非正
  await fillScalePoint(page, 2, "500", "1.0001");   // 实测四位小数
  await fillScalePoint(page, 3, "200", "abc");      // 实测非十进制

  const postRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/scale-checks"))
      postRequests.push(req.url());
  });

  await page.getByTestId("scale-submit").click();

  await expect(page.getByTestId("scale-error-0-standard")).toContainText("必须大于零");
  await expect(page.getByTestId("scale-error-1-measured")).toContainText("最多三位小数");
  await expect(page.getByTestId("scale-error-2-measured")).toContainText("十进制");
  expect(postRequests).toEqual([]);
  await expect(page.getByTestId("scale-saved")).toHaveCount(0);

  // 当前输入保留，可就地修改
  await expect(page.getByLabel("第1测点标准重量（克）")).toHaveValue("0");
  await expect(page.getByLabel("第2测点实测重量（克）")).toHaveValue("1.0001");

  // 台账数量不变（直接绕开页面再验证后端对各非法形态也 400 且零落库）
  const badPayloads = [
    { device_no: device, check_date: "2026-02-30", points: [
      { standard: "1", measured: "1" }, { standard: "1", measured: "1" }, { standard: "1", measured: "1" }] },
    { device_no: device, check_date: "2026/09/13", points: [
      { standard: "1", measured: "1" }, { standard: "1", measured: "1" }, { standard: "1", measured: "1" }] },
    { device_no: device, check_date: "2026-09-13", points: [
      { standard: "1", measured: "1" }, { standard: "1", measured: "1" }] },
    { device_no: "  ", check_date: "2026-09-13", points: [
      { standard: "1", measured: "1" }, { standard: "1", measured: "1" }, { standard: "1", measured: "1" }] },
  ];
  for (const data of badPayloads) {
    const r = await page.request.post("/api/scale-checks", { data });
    expect(r.status()).toBe(400);
  }
  expect(await scaleCount(page)).toBe(before);
});

test("秤检同日重复：页面与后端都拒绝，保留输入且台账数量不变", async ({ page }) => {
  const device = nextDeviceNo();
  const data = {
    device_no: device,
    check_date: "2026-09-13",
    points: [
      { standard: "1000.000", measured: "1000.100" },
      { standard: "500.000", measured: "499.900" },
      { standard: "200.000", measured: "200.000" },
    ],
  };
  const first = await page.request.post("/api/scale-checks", { data });
  expect(first.status()).toBe(201);
  const before = await scaleCount(page);

  await gotoScale(page);
  await page.getByTestId("scale-device").fill(device);
  await page.getByTestId("scale-date").fill("2026-09-13");
  await fillScalePoint(page, 1, "1000.000", "1000.200");
  await fillScalePoint(page, 2, "500.000", "500.000");
  await fillScalePoint(page, 3, "200.000", "200.100");

  // 本地预判重复：不发 POST，提示重复日期，输入保留
  const postUrls: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/scale-checks"))
      postUrls.push(req.url());
  });
  await page.getByTestId("scale-submit").click();
  await expect(page.getByTestId("scale-date-error")).toContainText("已有秤检记录");
  expect(postUrls).toEqual([]);
  await expect(page.getByLabel("第1测点实测重量（克）")).toHaveValue("1000.200");

  // 直接打后端重复提交：409，回滚后只剩第一条
  const dup = await page.request.post("/api/scale-checks", { data });
  expect(dup.status()).toBe(409);
  const dupBody = await dup.json();
  expect(dupBody.detail).toContain(device);
  expect(dupBody.detail).toContain("2026-09-13");
  expect(await scaleCount(page)).toBe(before);

  // 同设备不同日期、不同设备同日期都允许
  const otherDay = await page.request.post("/api/scale-checks", {
    data: { ...data, check_date: "2026-09-14" },
  });
  expect(otherDay.status()).toBe(201);
  const otherDevice = await page.request.post("/api/scale-checks", {
    data: { ...data, device_no: nextDeviceNo() },
  });
  expect(otherDevice.status()).toBe(201);
});

test("秤检独立于批次：秤检不阻断批次创建，批次列表/详情行为保持原样", async ({ page }) => {
  // 先有一条不合格秤检
  const device = nextDeviceNo();
  const scale = await page.request.post("/api/scale-checks", {
    data: {
      device_no: device,
      check_date: "2026-09-13",
      points: [
        { standard: "100.000", measured: "100.000" },
        { standard: "100.000", measured: "100.000" },
        { standard: "100.000", measured: "100.501" },
      ],
    },
  });
  expect(scale.status()).toBe(201);
  expect((await scale.json()).passed).toBe(false);

  // 批次核算照常闭合保存（不被秤检阻断，也不读取秤检结果）
  const batchNo = `SCL-IND-${scaleStamp}-${scaleCounter}`;
  await page.goto("/");
  await page.getByTestId("batch-no").fill(batchNo);
  await page.getByLabel("领料第1笔重量（克）").fill("1000.000");
  await page.getByLabel("成品第1笔重量（克）").fill("1000.000");
  await expect(page.getByTestId("preview-verdict")).toHaveText("预览裁决：闭合");
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("detail-verdict")).toHaveText("闭合");

  // 批次资源里不含秤检；秤检资源里不含批次
  const batches = (await (await page.request.get("/api/batches")).json()) as Array<{
    batch_no: string;
  }>;
  expect(batches.some((b) => b.batch_no === batchNo)).toBe(true);
  const scales = (await (await page.request.get("/api/scale-checks")).json()) as Array<{
    device_no: string;
  }>;
  expect(scales.some((s) => s.device_no === device)).toBe(true);
});
