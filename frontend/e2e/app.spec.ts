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
