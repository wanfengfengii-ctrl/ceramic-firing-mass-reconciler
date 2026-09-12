import { describe, expect, it } from "vitest";
import {
  formatGrams,
  parseGrams,
  reckonMg,
  subtotalMg,
  validateAndParse,
  type Kind,
} from "./domain";

const empty = (): Record<Kind, string[]> => ({
  issued: [],
  returned: [],
  product: [],
  scrap: [],
});

describe("parseGrams", () => {
  it("解析三位小数为毫克整数", () => {
    const p = parseGrams("12.001");
    expect(p.ok && p.mg).toBe(12001n);
    const small = parseGrams("0.001");
    expect(small.ok && small.mg).toBe(1n);
  });

  it("拒绝零、负数与超过三位小数", () => {
    expect(parseGrams("0")).toMatchObject({ ok: false });
    expect(parseGrams("-1")).toMatchObject({ ok: false });
    expect(parseGrams("1.0001")).toMatchObject({ ok: false, error: "最多三位小数" });
  });

  it("拒绝非十进制文本", () => {
    expect(parseGrams("abc")).toMatchObject({ ok: false });
    expect(parseGrams("")).toMatchObject({ ok: false });
    expect(parseGrams("1,2")).toMatchObject({ ok: false });
  });

  it("科学计数法只在三位小数边界内成立", () => {
    // 1e-3 = 0.001 合法；1e-4 小数位四位不合法
    const ok = parseGrams("1e-3");
    expect(ok.ok && ok.mg).toBe(1n);
    expect(parseGrams("1e-4")).toMatchObject({ ok: false, error: "最多三位小数" });
  });
});

describe("formatGrams", () => {
  it("三位小数并带符号", () => {
    expect(formatGrams(12001n)).toBe("12.001");
    expect(formatGrams(-5000n, true)).toBe("-5.000");
    expect(formatGrams(5000n, true)).toBe("+5.000");
  });
});

describe("reckonMg", () => {
  const totals = (v: Partial<Record<Kind, bigint>>) => ({
    issued: 0n,
    returned: 0n,
    product: 0n,
    scrap: 0n,
    ...v,
  });

  it("允许差取 5 克与 0.2%（ROUND_HALF_UP 整数克）较大者", () => {
    // 净投入 2750 -> 0.2%=5.5 -> HALF_UP 6
    const r = reckonMg(totals({ issued: 2750000n, product: 2750000n }));
    expect(r.toleranceMg).toBe(6000n);
    // 净投入 2000 -> 0.2%=4 -> 取下限 5
    const r2 = reckonMg(totals({ issued: 2000000n, product: 2000000n }));
    expect(r2.toleranceMg).toBe(5000n);
    // 净投入 2250 -> 0.2%=4.5 -> 5
    const r3 = reckonMg(totals({ issued: 2250000n, product: 2250000n }));
    expect(r3.toleranceMg).toBe(5000n);
  });

  it("差额带符号，闭合边界为绝对值比较", () => {
    const over = reckonMg(totals({ issued: 1000000n, product: 1005000n }));
    expect(over.differenceMg).toBe(5000n);
    expect(over.closed).toBe(true);
    const beyond = reckonMg(totals({ issued: 1000000n, product: 1005001n }));
    expect(beyond.differenceMg).toBe(5001n);
    expect(beyond.closed).toBe(false);
    const under = reckonMg(totals({ issued: 1000000n, product: 995000n }));
    expect(under.differenceMg).toBe(-5000n);
    expect(under.closed).toBe(true);
  });

  it("净投入与产出公式", () => {
    const r = reckonMg(
      totals({
        issued: 1500003n,
        returned: 100001n,
        product: 1400004n,
        scrap: 8001n,
      }),
    );
    expect(r.netInputMg).toBe(1400002n);
    expect(r.outputMg).toBe(1408005n);
    expect(r.differenceMg).toBe(8003n);
    expect(r.closed).toBe(false);
  });
});

describe("subtotalMg", () => {
  it("忽略空白行并精确合计，非法输入返回 null", () => {
    expect(subtotalMg(["1.001", "  ", "2.002"])).toBe(3003n);
    expect(subtotalMg(["1.0001"])).toBeNull();
    expect(subtotalMg([])).toBe(0n);
  });
});

describe("validateAndParse", () => {
  it("要求至少一笔领料", () => {
    const r = validateAndParse(empty());
    expect(r.ok).toBe(false);
  });

  it("退料总量不得大于领料总量", () => {
    const rows = empty();
    rows.issued = ["100.000"];
    rows.returned = ["100.001"];
    const r = validateAndParse(rows);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("退料") });
  });

  it("定位到具体分区与行号", () => {
    const rows = empty();
    rows.issued = ["100", "0"];
    const r = validateAndParse(rows);
    expect(r).toMatchObject({ ok: false, error: "领料 第 2 笔：必须大于零" });
  });

  it("合法输入返回毫克行与合计", () => {
    const rows = empty();
    rows.issued = ["100.000", "50.000"];
    rows.product = ["150.000"];
    const r = validateAndParse(rows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.weights.issued).toEqual([100000n, 50000n]);
      expect(r.totals.issued).toBe(150000n);
    }
  });
});
