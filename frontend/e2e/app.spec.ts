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

