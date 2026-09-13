import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type {
  BatchCompare,
  BatchDetail,
  BatchSummary,
  ImportPreviewResponse,
} from "./api";

const detailClosed: BatchDetail = {
  id: 7,
  batch_no: "K-7",
  closed: true,
  verdict: "闭合",
  issued_total: "1000.000",
  returned_total: "0.000",
  product_total: "1005.000",
  scrap_total: "0.000",
  net_input: "1000.000",
  output_total: "1005.000",
  difference: "+5.000",
  tolerance: "5",
  entries: {
    issued: [{ seq: 1, weight: "1000.000", mode: "single" }],
    returned: [],
    product: [{ seq: 1, weight: "1005.000", mode: "single" }],
    scrap: [],
  },
  created_at: "2026-09-12T10:00:00+00:00",
};

const summary: BatchSummary = {
  id: 7,
  batch_no: "K-7",
  closed: true,
  verdict: "闭合",
  net_input: "1000.000",
  difference: "+5.000",
  tolerance: "5",
  created_at: "2026-09-12T10:00:00+00:00",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("App 核算站", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/batches" && method === "GET") return jsonResponse([]);
      return jsonResponse({ detail: "未预期的请求" }, 500);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("以十进制字符串提交四个分区，展示原始行/合计/差额/允许差/裁决", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([summary]);
        if (url === "/api/batches" && method === "POST") {
          const payload = JSON.parse(init!.body as string);
          // 重量必须是字符串而非 number
          expect(typeof payload.entries.issued[0]).toBe("string");
          return jsonResponse(detailClosed, 201);
        }
        return jsonResponse({ detail: "未预期" }, 500);
      },
    );

    render(<App />);

    await user.type(screen.getByTestId("batch-no"), "K-7");
    const issuedInput = screen.getByLabelText("领料第1笔重量（克）");
    await user.clear(issuedInput);
    await user.type(issuedInput, "1000");
    const productInput = screen.getByLabelText("成品第1笔重量（克）");
    await user.clear(productInput);
    await user.type(productInput, "1005");

    // 本地预览即给出裁决
    expect(screen.getByTestId("preview-difference")).toHaveTextContent("+5.000");
    expect(screen.getByTestId("preview-verdict")).toHaveTextContent("闭合");

    await user.click(screen.getByTestId("submit"));

    const detail = await screen.findByTestId("batch-detail");
    expect(screen.getByTestId("detail-verdict")).toHaveTextContent("闭合");
    expect(within(detail).getByTestId("detail-difference")).toHaveTextContent("+5.000");
    expect(within(detail).getByTestId("detail-tolerance")).toHaveTextContent("5");
    expect(within(detail).getByTestId("detail-net")).toHaveTextContent("1000.000");
    expect(within(detail).getByTestId("raw-issued")).toHaveTextContent("1000.000");
  });

  it("成组录入：即时显示乘积并带入预览，提交依据对象，详情还原算式", async () => {
    const user = userEvent.setup();
    const groupDetail: BatchDetail = {
      ...detailClosed,
      id: 8,
      batch_no: "G-8",
      issued_total: "1100.000",
      net_input: "1100.000",
      output_total: "1100.000",
      product_total: "1100.000",
      difference: "+0.000",
      entries: {
        issued: [
          { seq: 1, weight: "1000.000", mode: "single" },
          { seq: 2, weight: "100.000", mode: "group", unit_weight: "12.500", count: 8 },
        ],
        returned: [],
        product: [{ seq: 1, weight: "1100.000", mode: "single" }],
        scrap: [],
      },
    };
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches" && method === "POST") {
          const payload = JSON.parse(init!.body as string);
          // 单笔仍是字符串；成组是含录入方式/单份/份数的对象（不含乘积）
          expect(payload.entries.issued[0]).toBe("1000");
          expect(payload.entries.issued[1]).toEqual({
            mode: "group",
            unit_weight: "12.500",
            count: 8,
          });
          return jsonResponse(groupDetail, 201);
        }
        return jsonResponse({ detail: "未预期" }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "G-8");

    const issuedPanel = screen.getByLabelText("领料分区");
    const issuedWeight = within(issuedPanel).getByLabelText("领料第1笔重量（克）");
    await user.clear(issuedWeight);
    await user.type(issuedWeight, "1000");

    // 添加第二行并切换为成组（DOM 顺序中第二个“成组”单选即第二行）
    await user.click(within(issuedPanel).getByRole("button", { name: "+ 添加一笔领料" }));
    await user.click(
      within(issuedPanel).getAllByRole("radio", { name: "成组" })[1],
    );

    const unit = within(issuedPanel).getByLabelText("领料第2笔单份重量（克）");
    const count = within(issuedPanel).getByLabelText("领料第2笔份数");
    await user.type(unit, "12.500");
    await user.type(count, "8");

    // 页面十进制乘法即时显示采用重量
    expect(within(issuedPanel).getByTestId("adopted-issued-1")).toHaveTextContent(
      "= 100.000 g",
    );
    // 领料小计 = 1000 + 12.5*8 = 1100
    expect(within(issuedPanel).getByTestId("subtotal-issued")).toHaveTextContent("1100.000");

    const productPanel = screen.getByLabelText("成品分区");
    const productWeight = within(productPanel).getByLabelText("成品第1笔重量（克）");
    await user.clear(productWeight);
    await user.type(productWeight, "1100");
    expect(screen.getByTestId("preview-difference")).toHaveTextContent("+0.000");
    expect(screen.getByTestId("preview-verdict")).toHaveTextContent("闭合");

    await user.click(screen.getByTestId("submit"));

    const detail = await screen.findByTestId("batch-detail");
    const rawIssued = within(detail).getByTestId("raw-issued");
    // 成组行还原“单份 × 份数 = 采用重量”
    const groupLine = within(rawIssued).getByTestId("raw-issued-2-group");
    expect(groupLine).toHaveTextContent("12.500 g × 8 桶 = 100.000 g");
  });

  it("成组份数越界时本地定位到对应分区和行，且不发请求", async () => {
    const user = userEvent.setup();
    const postSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ detail: "不应被调用" }, 500),
    );
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches" && method === "POST") return postSpy(url, init);
        return jsonResponse({ detail: "未预期" }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "BAD-GROUP");
    const issuedPanel = screen.getByLabelText("领料分区");
    await user.click(within(issuedPanel).getAllByRole("radio", { name: "成组" })[0]);
    await user.type(within(issuedPanel).getByLabelText("领料第1笔单份重量（克）"), "12.5");
    await user.type(within(issuedPanel).getByLabelText("领料第1笔份数"), "1000");

    // 行内即时提示乘积错误
    expect(within(issuedPanel).getByTestId("adopted-issued-0")).toHaveTextContent("份数");
    // 预览也无法核算并定位行号
    expect(screen.getByText(/当前输入尚不能核算/)).toHaveTextContent("领料 第 1 笔");

    await user.click(screen.getByTestId("submit"));

    const error = await screen.findByTestId("form-error");
    expect(error).toHaveTextContent("领料 第 1 笔：份数必须在 2 与 999 之间");
    expect(screen.queryByTestId("batch-detail")).not.toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("领料首行空白、第二行份数越界：提示行号与界面行号一致并定位第二行", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: "不应被调用" }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "ROW-NO");
    const issuedPanel = screen.getByLabelText("领料分区");
    // 第一行保留空白，添加第二行并切换为成组录入越界份数
    await user.click(within(issuedPanel).getByRole("button", { name: "+ 添加一笔领料" }));
    await user.click(within(issuedPanel).getAllByRole("radio", { name: "成组" })[1]);
    await user.type(within(issuedPanel).getByLabelText("领料第2笔单份重量（克）"), "12.5");
    const count = within(issuedPanel).getByLabelText("领料第2笔份数");
    await user.type(count, "1000");

    await user.click(screen.getByTestId("submit"));

    const error = await screen.findByTestId("form-error");
    // 提示行号与界面“第 2 笔”标签一致，且聚焦到第二行的份数输入
    expect(error).toHaveTextContent("领料 第 2 笔：份数必须在 2 与 999 之间");
    expect(count).toHaveFocus();
  });

  it("同一非法成组行不修改再次提交，每次都重新聚焦对应输入", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: "不应被调用" }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "REFOCUS");
    const issuedPanel = screen.getByLabelText("领料分区");
    await user.click(within(issuedPanel).getAllByRole("radio", { name: "成组" })[0]);
    await user.type(within(issuedPanel).getByLabelText("领料第1笔单份重量（克）"), "12.5");
    const count = within(issuedPanel).getByLabelText("领料第1笔份数");
    await user.type(count, "1000");

    await user.click(screen.getByTestId("submit"));
    await screen.findByTestId("form-error");
    expect(count).toHaveFocus();

    // 不修改任何输入，把焦点移到别处后再次提交：仍应重新聚焦份数输入
    await user.click(screen.getByTestId("batch-no"));
    expect(count).not.toHaveFocus();
    await user.click(screen.getByTestId("submit"));
    await screen.findByTestId("form-error");
    expect(count).toHaveFocus();
  });

  it("领料取存储上限、成品废料各六百亿克：整批校验拒绝产出合计超限且不发请求", async () => {
    const user = userEvent.setup();
    const postSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ detail: "不应被调用" }, 500),
    );
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches" && method === "POST") return postSpy(url, init);
        return jsonResponse({ detail: "未预期" }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "OVER-OUTPUT");
    await user.type(screen.getByLabelText("领料第1笔重量（克）"), "99999999999.999");
    await user.type(screen.getByLabelText("成品第1笔重量（克）"), "60000000000");
    const scrapWeight = screen.getByLabelText("废料第1笔重量（克）");
    await user.type(scrapWeight, "60000000000");

    // 预览即提示产出合计超限，无法核算
    expect(screen.getByText(/当前输入尚不能核算/)).toHaveTextContent("产出合计");

    await user.click(screen.getByTestId("submit"));

    const error = await screen.findByTestId("form-error");
    expect(error).toHaveTextContent(
      "产出合计 120000000000.000 g 超出存储范围（≤ 99999999999.999 g）",
    );
    // 定位到废料分区第一笔
    expect(scrapWeight).toHaveFocus();
    expect(screen.queryByTestId("batch-detail")).not.toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("单笔非法重量在提交前被本地十进制校验拦下", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches" && method === "POST") {
          return jsonResponse({ detail: "领料 第 1 笔：重量必须大于零" }, 400);
        }
        return jsonResponse({ detail: "未预期" }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "BAD-1");
    const issued = screen.getByLabelText("领料第1笔重量（克）");
    await user.clear(issued);
    await user.type(issued, "0");
    // 前端也能在提交前给出十进制预览的错误状态
    expect(screen.getByText(/当前输入尚不能核算/)).toBeInTheDocument();
    await user.click(screen.getByTestId("submit"));

    const error = await screen.findByTestId("form-error");
    expect(error).toHaveTextContent("必须大于零");
    expect(screen.queryByTestId("batch-detail")).not.toBeInTheDocument();
  });

  it("浏览器刷新后仍得到同一业务结果：挂载即拉取已保存批次与详情", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url === "/api/batches") return jsonResponse([summary]);
        if (url === "/api/batches/7") return jsonResponse(detailClosed);
        return jsonResponse({ detail: "未预期" }, 500);
      },
    );

    render(<App />);
    const row = await screen.findByTestId("row-7");
    expect(row).toHaveTextContent("K-7");
    expect(row).toHaveTextContent("+5.000");
    expect(row).toHaveTextContent("闭合");

    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: "查看可复算详情" }));

    const detail = await screen.findByTestId("batch-detail");
    await waitFor(() =>
      expect(within(detail).getByTestId("detail-difference")).toHaveTextContent("+5.000"),
    );
  });

  // ---------------------------------------------------------------------
  // 批次对比：详情区选择基准批次，并排核对双方快照与带符号差异
  // ---------------------------------------------------------------------

  const detailOpen: BatchDetail = {
    ...detailClosed,
    id: 9,
    batch_no: "K-9",
    closed: false,
    verdict: "不闭合",
    issued_total: "3000.000",
    product_total: "3010.000",
    net_input: "3000.000",
    output_total: "3010.000",
    difference: "+10.000",
    tolerance: "6",
    entries: {
      issued: [{ seq: 1, weight: "3000.000", mode: "single" }],
      returned: [],
      product: [{ seq: 1, weight: "3010.000", mode: "single" }],
      scrap: [],
    },
  };

  const summaryOpen: BatchSummary = {
    id: 9,
    batch_no: "K-9",
    closed: false,
    verdict: "不闭合",
    net_input: "3000.000",
    difference: "+10.000",
    tolerance: "6",
    created_at: "2026-09-12T11:00:00+00:00",
  };

  const compareResult: BatchCompare = {
    current: { id: 9, batch_no: "K-9", closed: false, verdict: "不闭合" },
    base: { id: 7, batch_no: "K-7", closed: true, verdict: "闭合" },
    issued_total: { current: "3000.000", base: "1000.000", delta: "+2000.000" },
    returned_total: { current: "0.000", base: "0.000", delta: "+0.000" },
    net_input: { current: "3000.000", base: "1000.000", delta: "+2000.000" },
    product_total: { current: "3010.000", base: "1005.000", delta: "+2005.000" },
    scrap_total: { current: "0.000", base: "0.000", delta: "+0.000" },
    output_total: { current: "3010.000", base: "1005.000", delta: "+2005.000" },
    difference: { current: "+10.000", base: "+5.000", delta: "+5.000" },
    tolerance: { current: "6.000", base: "5.000", delta: "+1.000" },
    verdict_changed: true,
  };

  /** 打开 K-9 的详情并返回对比区控件。 */
  async function openDetailAndCompare(user: ReturnType<typeof userEvent.setup>) {
    render(<App />);
    const row = await screen.findByTestId("row-9");
    await user.click(within(row).getByRole("button", { name: "查看可复算详情" }));
    await screen.findByTestId("batch-detail");
    return {
      select: screen.getByTestId("compare-base-select") as HTMLSelectElement,
      runButton: screen.getByTestId("compare-run"),
    };
  }

  it("详情区选择基准批次对比：展示基准摘要、带符号差异与裁决变化", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url === "/api/batches") return jsonResponse([summaryOpen, summary]);
        if (url === "/api/batches/9") return jsonResponse(detailOpen);
        if (url === "/api/batches/9/compare?base_id=7") return jsonResponse(compareResult);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    const { select, runButton } = await openDetailAndCompare(user);
    await user.selectOptions(select, "7");
    await user.click(runButton);

    const result = await screen.findByTestId("compare-result");
    // 基准摘要：双方批次号与裁决
    expect(within(result).getByTestId("compare-base-summary")).toHaveTextContent(
      "K-9（不闭合）对比基准批次 K-7（闭合）",
    );
    // 裁决变化
    expect(within(result).getByTestId("compare-verdict-change")).toHaveTextContent(
      "闭合 → 不闭合",
    );
    // 带符号差异：正增、零、负向相反
    expect(within(result).getByTestId("compare-delta-net_input")).toHaveTextContent(
      "+2000.000 g",
    );
    expect(within(result).getByTestId("compare-delta-difference")).toHaveTextContent(
      "+5.000 g",
    );
    expect(within(result).getByTestId("compare-delta-tolerance")).toHaveTextContent(
      "+1.000 g",
    );
    expect(within(result).getByTestId("compare-delta-scrap_total")).toHaveTextContent(
      "+0.000 g",
    );
    // 双方快照值同列呈现
    expect(within(result).getByTestId("compare-row-net_input")).toHaveTextContent(
      "3000.000",
    );
    expect(within(result).getByTestId("compare-row-net_input")).toHaveTextContent(
      "1000.000",
    );
  });

  it("选择自身作为基准时页面阻止请求，不发对比请求", async () => {
    const user = userEvent.setup();
    const compareSpy = vi.fn(async () => jsonResponse(compareResult));
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url === "/api/batches") return jsonResponse([summaryOpen, summary]);
        if (url === "/api/batches/9") return jsonResponse(detailOpen);
        if (url.includes("/compare")) return compareSpy();
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    const { select, runButton } = await openDetailAndCompare(user);
    // 基准下拉里包含当前批次自身，选择后点击对比
    await user.selectOptions(select, "9");
    await user.click(runButton);

    const error = await screen.findByTestId("compare-error");
    expect(error).toHaveTextContent("自身");
    expect(compareSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("compare-result")).not.toBeInTheDocument();
    // 详情保持打开
    expect(screen.getByTestId("batch-detail")).toBeInTheDocument();
  });

  it("对比读取失败后保留当前详情与基准选择，可直接重试", async () => {
    const user = userEvent.setup();
    let compareCalls = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url === "/api/batches") return jsonResponse([summaryOpen, summary]);
        if (url === "/api/batches/9") return jsonResponse(detailOpen);
        if (url === "/api/batches/9/compare?base_id=7") {
          compareCalls += 1;
          // 第一次失败（如基准已被清理），第二次成功
          return compareCalls === 1
            ? jsonResponse({ detail: "基准批次 7 不存在" }, 404)
            : jsonResponse(compareResult);
        }
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    const { select, runButton } = await openDetailAndCompare(user);
    await user.selectOptions(select, "7");
    await user.click(runButton);

    // 失败：错误提示出现，详情与基准选择都保留
    const error = await screen.findByTestId("compare-error");
    expect(error).toHaveTextContent("基准批次 7 不存在");
    expect(screen.getByTestId("batch-detail")).toBeInTheDocument();
    expect(select.value).toBe("7");
    expect(screen.queryByTestId("compare-result")).not.toBeInTheDocument();

    // 不重新选择，直接再次发起对比即成功
    await user.click(runButton);
    expect(await screen.findByTestId("compare-result")).toBeInTheDocument();
    expect(screen.queryByTestId("compare-error")).not.toBeInTheDocument();
    expect(compareCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 称重文件导入：预检 → 确认替换 → 现有方式提交；失败/取消不动当前内容
// ---------------------------------------------------------------------------

describe("称重文件导入", () => {
  const CSV = [
    "分区,重量,单份重量,份数",
    "领料,1000.000,,",
    "领料,,12.500,8",
    "退料,,10.000,5",
    "成品,1040.000,,",
    "废料,60.000,,",
  ].join("\n");

  const importResult: ImportPreviewResponse = {
    row_count: 5,
    entries: {
      issued: [
        { seq: 1, weight: "1000.000", mode: "single" },
        { seq: 2, weight: "100.000", mode: "group", unit_weight: "12.500", count: 8 },
      ],
      returned: [
        { seq: 1, weight: "50.000", mode: "group", unit_weight: "10.000", count: 5 },
      ],
      product: [{ seq: 1, weight: "1040.000", mode: "single" }],
      scrap: [{ seq: 1, weight: "60.000", mode: "single" }],
    },
    preview: {
      issued_total: "1100.000",
      returned_total: "50.000",
      product_total: "1040.000",
      scrap_total: "60.000",
      net_input: "1050.000",
      output_total: "1100.000",
      difference: "+50.000",
      tolerance: "5",
      closed: false,
      verdict: "不闭合",
    },
  };

  const savedDetail: BatchDetail = {
    id: 11,
    batch_no: "IMP-11",
    closed: false,
    verdict: "不闭合",
    issued_total: "1100.000",
    returned_total: "50.000",
    product_total: "1040.000",
    scrap_total: "60.000",
    net_input: "1050.000",
    output_total: "1100.000",
    difference: "+50.000",
    tolerance: "5",
    entries: {
      issued: [
        { seq: 1, weight: "1000.000", mode: "single" },
        { seq: 2, weight: "100.000", mode: "group", unit_weight: "12.500", count: 8 },
      ],
      returned: [
        { seq: 1, weight: "50.000", mode: "group", unit_weight: "10.000", count: 5 },
      ],
      product: [{ seq: 1, weight: "1040.000", mode: "single" }],
      scrap: [{ seq: 1, weight: "60.000", mode: "single" }],
    },
    created_at: "2026-09-13T08:00:00+00:00",
  };

  const csvFile = (content: string) =>
    new File([content], "weigh-0913.csv", { type: "text/csv" });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/batches" && method === "GET") return jsonResponse([]);
      return jsonResponse({ detail: "未预期的请求" }, 500);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("预检展示规范化行与核算预览，确认后替换录入并保留批次号，再按现有方式提交", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches/import-preview" && method === "POST") {
          const payload = JSON.parse(init!.body as string);
          // 上送的是文件 UTF-8 文本
          expect(payload.content).toBe(CSV);
          return jsonResponse(importResult);
        }
        if (url === "/api/batches" && method === "POST") {
          const payload = JSON.parse(init!.body as string);
          // 确认导入后仍通过现有创建接口提交：单笔字符串 + 成组对象
          expect(payload.batch_no).toBe("IMP-11");
          expect(payload.entries.issued).toEqual([
            "1000.000",
            { mode: "group", unit_weight: "12.500", count: 8 },
          ]);
          expect(payload.entries.returned).toEqual([
            { mode: "group", unit_weight: "10.000", count: 5 },
          ]);
          expect(payload.entries.product).toEqual(["1040.000"]);
          expect(payload.entries.scrap).toEqual(["60.000"]);
          return jsonResponse(savedDetail, 201);
        }
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    // 先手工填写批次号与一笔将被替换的内容
    await user.type(screen.getByTestId("batch-no"), "IMP-11");
    await user.type(screen.getByLabelText("成品第1笔重量（克）"), "777");

    await user.upload(screen.getByTestId("import-file"), csvFile(CSV));

    // 预检面板：规范化行（含成组算式）与核算预览
    const panel = await screen.findByTestId("import-preview");
    expect(within(panel).getByTestId("import-raw-issued-2-group")).toHaveTextContent(
      "12.500 g × 8 桶 = 100.000 g",
    );
    expect(within(panel).getByTestId("import-preview-difference")).toHaveTextContent(
      "+50.000 g",
    );
    expect(within(panel).getByTestId("import-preview-verdict")).toHaveTextContent(
      "不闭合",
    );
    // 确认前：手工内容原样保留
    expect(screen.getByLabelText("成品第1笔重量（克）")).toHaveValue("777");

    await user.click(within(panel).getByTestId("import-confirm"));

    // 替换后：批次号保留，四个分区被导入行整体替换
    expect(screen.getByTestId("batch-no")).toHaveValue("IMP-11");
    expect(screen.getByLabelText("领料第1笔重量（克）")).toHaveValue("1000.000");
    expect(screen.getByLabelText("领料第2笔单份重量（克）")).toHaveValue("12.500");
    expect(screen.getByLabelText("领料第2笔份数")).toHaveValue("8");
    expect(screen.getByLabelText("成品第1笔重量（克）")).toHaveValue("1040.000");
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument();
    // 现有本地预览即时反映导入内容
    expect(screen.getByTestId("preview-difference")).toHaveTextContent("+50.000");
    expect(screen.getByTestId("preview-verdict")).toHaveTextContent("不闭合");

    await user.click(screen.getByTestId("submit"));
    const detail = await screen.findByTestId("batch-detail");
    expect(within(detail).getByTestId("detail-verdict")).toHaveTextContent("不闭合");
    expect(within(detail).getByTestId("raw-issued-2-group")).toHaveTextContent(
      "12.500 g × 8 桶 = 100.000 g",
    );
  });

  it("预检失败：提示 CSV 行号，当前表单与最近一次核算详情均不丢失", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([summary]);
        if (url === "/api/batches/7") return jsonResponse(detailClosed);
        if (url === "/api/batches/import-preview" && method === "POST") {
          return jsonResponse(
            {
              detail: "第 4 行：成品 第 1 笔：无法识别的重量 'abc'",
              line: 4,
              reason: "成品 第 1 笔：无法识别的重量 'abc'",
            },
            400,
          );
        }
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    // 打开最近一次核算详情，并手工填写内容
    const row = await screen.findByTestId("row-7");
    await user.click(within(row).getByRole("button", { name: "查看可复算详情" }));
    await screen.findByTestId("batch-detail");
    await user.type(screen.getByTestId("batch-no"), "KEEP-1");
    await user.type(screen.getByLabelText("领料第1笔重量（克）"), "123.456");

    const badCsv = ["分区,重量,单份重量,份数", "领料,1000.000,,", "", "成品,abc,,"].join("\n");
    await user.upload(screen.getByTestId("import-file"), csvFile(badCsv));

    // 错误精确指向原始行号；表单、批次号与详情全部保留
    const error = await screen.findByTestId("import-error");
    expect(error).toHaveTextContent("第 4 行");
    expect(error).toHaveTextContent("无法识别");
    expect(screen.getByLabelText("领料第1笔重量（克）")).toHaveValue("123.456");
    expect(screen.getByTestId("batch-no")).toHaveValue("KEEP-1");
    expect(screen.getByTestId("batch-detail")).toBeInTheDocument();
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument();
  });

  it("文件含非法 UTF-8 字节：浏览器侧整份拒绝且不发预检请求，当前表单保留", async () => {
    const user = userEvent.setup();
    let previewRequested = false;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches/import-preview" && method === "POST") {
          previewRequested = true;
          return jsonResponse(importResult);
        }
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "UTF8-KEEP");
    await user.type(screen.getByLabelText("领料第1笔重量（克）"), "123.456");

    // 合法表头 + 数据行，附加备注列末尾是非法 UTF-8 字节序列（0xC3 0x28）：
    // Blob.text()/readAsText 会静默替换成 U+FFFD 后照常预检，严格解码必须拒绝
    const prefix = new TextEncoder().encode(
      ["分区,重量,单份重量,份数,备注", "领料,1000.000,,,,坏字节"].join("\n"),
    );
    const bytes = new Uint8Array(prefix.length + 2);
    bytes.set(prefix, 0);
    bytes[prefix.length] = 0xc3;
    bytes[prefix.length + 1] = 0x28;
    const badFile = new File([bytes], "weigh-bad-utf8.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("import-file"), badFile);

    const error = await screen.findByTestId("import-error");
    expect(error).toHaveTextContent("UTF-8");
    expect(error).not.toHaveTextContent("请重试");
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument();
    // 未调用预检接口：静默替换后的文本不可能被服务端接受而落库
    expect(previewRequested).toBe(false);
    // 当前表单与批次号原样保留
    expect(screen.getByLabelText("领料第1笔重量（克）")).toHaveValue("123.456");
    expect(screen.getByTestId("batch-no")).toHaveValue("UTF8-KEEP");
  });

  it("合法 BOM 的 UTF-8 文件正常预检（BOM 不被当作编码错误）", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches/import-preview" && method === "POST") {
          const payload = JSON.parse(init!.body as string);
          expect(payload.content.startsWith("﻿")).toBe(false);
          return jsonResponse(importResult);
        }
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    const bomFile = new File(["﻿" + CSV], "weigh-bom.csv", { type: "text/csv" });
    await user.upload(screen.getByTestId("import-file"), bomFile);
    expect(await screen.findByTestId("import-preview")).toBeInTheDocument();
  });

  it("取消替换：待导入方案被丢弃，手工内容不变", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches/import-preview" && method === "POST") {
          return jsonResponse(importResult);
        }
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await user.type(screen.getByTestId("batch-no"), "KEEP-2");
    await user.type(screen.getByLabelText("领料第1笔重量（克）"), "123.456");

    await user.upload(screen.getByTestId("import-file"), csvFile(CSV));
    await screen.findByTestId("import-preview");
    await user.click(screen.getByTestId("import-cancel"));

    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument();
    expect(screen.getByLabelText("领料第1笔重量（克）")).toHaveValue("123.456");
    expect(screen.getByTestId("batch-no")).toHaveValue("KEEP-2");
  });
});
