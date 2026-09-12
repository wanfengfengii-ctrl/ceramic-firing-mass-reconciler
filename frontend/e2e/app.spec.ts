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
