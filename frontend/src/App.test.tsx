import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { BatchDetail, BatchSummary } from "./api";

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
});
