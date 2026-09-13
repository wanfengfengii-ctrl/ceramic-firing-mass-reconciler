import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { ScaleCheck } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const savedPass: ScaleCheck = {
  id: 1,
  device_no: "DC-01",
  check_date: "2026-09-13",
  points: [
    { seq: 1, standard: "1000.000", measured: "1000.100", deviation: "+0.100" },
    { seq: 2, standard: "500.000", measured: "499.600", deviation: "-0.400" },
    { seq: 3, standard: "200.000", measured: "200.300", deviation: "+0.300" },
  ],
  passed: true,
  verdict: "合格",
  created_at: "2026-09-13T08:00:00+00:00",
};

/** 切到秤检工作台并等待台账查询完成。 */
async function openScaleWorkbench(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("tab-scale"));
  const workbench = await screen.findByTestId("scale-workbench");
  return workbench;
}

async function fillPoint(seq: number, standard: string, measured: string) {
  fireEvent.change(screen.getByLabelText(`第${seq}测点标准重量（克）`), {
    target: { value: standard },
  });
  fireEvent.change(screen.getByLabelText(`第${seq}测点实测重量（克）`), {
    target: { value: measured },
  });
}

describe("日常秤检工作台", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "未预期的请求" }, 500)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("即时显示各组带符号偏差；合格秤检保存后展示本次结论并刷新倒序台账", async () => {
    const user = userEvent.setup();
    let getCalls = 0;
    const postSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(init!.body as string);
      // 重量以三位小数字符串上送，绝不是 number；偏差不在请求里（后端复算）
      expect(payload).toEqual({
        device_no: "DC-01",
        check_date: "2026-09-13",
        points: [
          { standard: "1000.000", measured: "1000.100" },
          { standard: "500.000", measured: "499.600" },
          { standard: "200.000", measured: "200.300" },
        ],
      });
      return jsonResponse(savedPass, 201);
    });
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET") {
          getCalls += 1;
          // 第一次（挂载）为空；保存后再次查询返回倒序台账
          return jsonResponse(getCalls === 1 ? [] : [savedPass]);
        }
        if (url === "/api/scale-checks" && method === "POST") return postSpy(url, init);
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(user);

    await user.type(screen.getByTestId("scale-device"), "DC-01");
    fireEvent.change(screen.getByTestId("scale-date"), {
      target: { value: "2026-09-13" },
    });
    await fillPoint(1, "1000", "1000.1");
    await fillPoint(2, "500", "499.6");
    await fillPoint(3, "200", "200.3");

    // 即时带符号偏差
    expect(screen.getByTestId("scale-deviation-0")).toHaveTextContent("+0.100 g");
    expect(screen.getByTestId("scale-deviation-1")).toHaveTextContent("-0.400 g");
    expect(screen.getByTestId("scale-deviation-2")).toHaveTextContent("+0.300 g");
    expect(screen.getByTestId("scale-preview-verdict")).toHaveTextContent("即时判定：合格");

    await user.click(screen.getByTestId("scale-submit"));

    const saved = await screen.findByTestId("scale-saved");
    expect(within(saved).getByTestId("scale-saved-verdict")).toHaveTextContent("合格");
    expect(postSpy).toHaveBeenCalledTimes(1);

    // 以同一资源查询契约恢复按日期倒序的记录
    await waitFor(() => expect(screen.getByTestId("scale-history")).toBeInTheDocument());
    const row = screen.getByTestId("scale-row-1");
    expect(row).toHaveTextContent("DC-01");
    expect(row).toHaveTextContent("2026-09-13");
    expect(row).toHaveTextContent("+0.100 / -0.400 / +0.300");
    expect(row).toHaveTextContent("合格");

    // 保存成功后表单清空
    expect(screen.getByTestId("scale-device")).toHaveValue("");
  });

  it("临界偏差：+0.500 g 合格，+0.501 g 不合格，前后端均按同一阈值", async () => {
    const user = userEvent.setup();
    const savedFail: ScaleCheck = {
      ...savedPass,
      id: 2,
      points: [
        { seq: 1, standard: "100.000", measured: "100.500", deviation: "+0.500" },
        { seq: 2, standard: "100.000", measured: "99.500", deviation: "-0.500" },
        { seq: 3, standard: "100.000", measured: "100.501", deviation: "+0.501" },
      ],
      passed: false,
      verdict: "不合格",
    };
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET") return jsonResponse([]);
        if (url === "/api/scale-checks" && method === "POST")
          return jsonResponse(savedFail, 201);
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(user);
    await user.type(screen.getByTestId("scale-device"), "DC-02");
    fireEvent.change(screen.getByTestId("scale-date"), { target: { value: "2026-09-13" } });

    // 先填两个临界合格点，第三点 +0.501：整体不合格
    await fillPoint(1, "100", "100.500");
    await fillPoint(2, "100", "99.500");
    expect(screen.getByTestId("scale-deviation-0")).toHaveTextContent("+0.500 g");
    expect(screen.getByTestId("scale-deviation-1")).toHaveTextContent("-0.500 g");
    await fillPoint(3, "100", "100.501");
    expect(screen.getByTestId("scale-deviation-2")).toHaveTextContent("+0.501 g");
    expect(screen.getByTestId("scale-preview-verdict")).toHaveTextContent("即时判定：不合格");

    // 不合格也是有效秤检，照常保存并展示本次结论
    await user.click(screen.getByTestId("scale-submit"));
    const saved = await screen.findByTestId("scale-saved");
    expect(within(saved).getByTestId("scale-saved-verdict")).toHaveTextContent("不合格");
  });

  it("字段非正或超过三位小数：保留当前输入，逐测点给出反馈且不发请求", async () => {
    const user = userEvent.setup();
    const postSpy = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ detail: "不应被调用" }, 500));
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET") return jsonResponse([]);
        if (url === "/api/scale-checks" && method === "POST") return postSpy(url, init);
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(user);
    await user.type(screen.getByTestId("scale-device"), "DC-03");
    fireEvent.change(screen.getByTestId("scale-date"), { target: { value: "2026-09-13" } });
    await fillPoint(1, "0", "100");
    await fillPoint(2, "500", "1.0001");
    await fillPoint(3, "200", "200.1");

    await user.click(screen.getByTestId("scale-submit"));

    // 明确反馈到测点与字段
    expect(screen.getByTestId("scale-error-0-standard")).toHaveTextContent("必须大于零");
    expect(screen.getByTestId("scale-error-1-measured")).toHaveTextContent("最多三位小数");
    // 非法测点不应出现结论/保存面板
    expect(screen.queryByTestId("scale-saved")).not.toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();

    // 当前输入原样保留，工艺员可就地修改
    expect(screen.getByLabelText("第1测点标准重量（克）")).toHaveValue("0");
    expect(screen.getByLabelText("第2测点实测重量（克）")).toHaveValue("1.0001");

    // 改合法后即时反馈消失、结论恢复
    await fillPoint(1, "100", "100");
    await fillPoint(2, "500", "500");
    expect(screen.queryByTestId("scale-error-0-standard")).not.toBeInTheDocument();
    expect(screen.getByTestId("scale-preview-verdict")).toHaveTextContent("即时判定：合格");
  });

  it("设备编号或日期缺失：聚焦并提示，保留已填测点", async () => {
    const user = userEvent.setup();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET") return jsonResponse([]);
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(user);
    await fillPoint(1, "100", "100");
    await fillPoint(2, "100", "100");
    await fillPoint(3, "100", "100");

    await user.click(screen.getByTestId("scale-submit"));
    expect(screen.getByTestId("scale-device-error")).toHaveTextContent("设备编号不能为空");
    expect(screen.getByTestId("scale-device")).toHaveFocus();

    await user.type(screen.getByTestId("scale-device"), "DC-04");
    // 原生日期输入留空（非法日历日期在 domain/后端层另测）：提示补填日期
    await user.click(screen.getByTestId("scale-submit"));
    expect(screen.getByTestId("scale-date-error")).toHaveTextContent("检验日期不能为空");
    // 测点输入保留
    expect(screen.getByLabelText("第1测点实测重量（克）")).toHaveValue("100");
  });

  it("同设备同日期重复：本地阻止重复提交、保留输入并提示重复日期，台账数量不变", async () => {
    const user = userEvent.setup();
    const postSpy = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ detail: "不应被调用" }, 500));
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET")
          return jsonResponse([savedPass]); // DC-01 @ 2026-09-13 已存在
        if (url === "/api/scale-checks" && method === "POST") return postSpy(url, init);
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(user);
    await user.type(screen.getByTestId("scale-device"), "DC-01");
    fireEvent.change(screen.getByTestId("scale-date"), { target: { value: "2026-09-13" } });
    await fillPoint(1, "100", "100");
    await fillPoint(2, "100", "100");
    await fillPoint(3, "100", "100");

    await user.click(screen.getByTestId("scale-submit"));
    expect(screen.getByTestId("scale-date-error")).toHaveTextContent("已有秤检记录");
    expect(postSpy).not.toHaveBeenCalled();
    // 当前输入保留，台账仍是查询到的那一条（数量不变）
    expect(screen.getByTestId("scale-device")).toHaveValue("DC-01");
    expect(screen.getAllByTestId(/^scale-row-/)).toHaveLength(1);
  });

  it("服务端 409 重复：输入保留、提示重复日期，失败后不新增记录", async () => {
    const user = userEvent.setup();
    let getCalls = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET") {
          getCalls += 1;
          // 本地列表没有该键（模拟其它工艺员刚提交）；POST 后刷新仍只有一条别人的记录
          return jsonResponse(getCalls === 1 ? [] : [{ ...savedPass, id: 9 }]);
        }
        if (url === "/api/scale-checks" && method === "POST")
          return jsonResponse(
            { detail: "设备 'DC-01' 在 2026-09-13 已有秤检记录，每日只能保存一次" },
            409,
          );
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(user);
    await user.type(screen.getByTestId("scale-device"), "DC-01");
    fireEvent.change(screen.getByTestId("scale-date"), { target: { value: "2026-09-13" } });
    await fillPoint(1, "100", "100");
    await fillPoint(2, "100", "100");
    await fillPoint(3, "100", "100");

    await user.click(screen.getByTestId("scale-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("scale-date-error")).toHaveTextContent("已有秤检记录"),
    );
    expect(screen.queryByTestId("scale-saved")).not.toBeInTheDocument();
    // 输入原样保留（规范化为三位小数只发生在请求体，失败时表单不动）；
    // 失败请求不触发成功后的刷新，台账仍为挂载时的零条——数量不变
    expect(screen.getByLabelText("第1测点标准重量（克）")).toHaveValue("100");
    expect(screen.queryByTestId(/^scale-row-/)).not.toBeInTheDocument();
  });

  it("刷新工作台：挂载即通过同一资源查询契约恢复倒序记录", async () => {
    const older: ScaleCheck = { ...savedPass, id: 2, device_no: "DC-02", check_date: "2026-09-11" };
    const newer: ScaleCheck = { ...savedPass, id: 1, check_date: "2026-09-13" };
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/scale-checks" && method === "GET")
          return jsonResponse([newer, older]); // 服务端已按日期倒序
        if (url === "/api/batches" && method === "GET") return jsonResponse([]);
        return jsonResponse({ detail: `未预期 ${url}` }, 500);
      },
    );

    render(<App />);
    await openScaleWorkbench(userEvent.setup());
    const history = await screen.findByTestId("scale-history");
    const rows = within(history).getAllByTestId(/^scale-row-/);
    expect(rows[0]).toHaveTextContent("2026-09-13");
    expect(rows[1]).toHaveTextContent("2026-09-11");
  });
});
