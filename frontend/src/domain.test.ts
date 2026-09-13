import { describe, expect, it } from "vitest";
import {
  MAX_STORED_MG,
  formatGrams,
  evaluateRow,
  isBlankRow,
  newSingleRow,
  parseGrams,
  reckonMg,
  subtotalRowsMg,
  validateRows,
  type FormRow,
  type Kind,
} from "./domain";

const empty = (): Record<Kind, FormRow[]> => ({
  issued: [],
  returned: [],
  product: [],
  scrap: [],
});

const single = (weight: string): FormRow => ({
  mode: "single",
  weight,
  unitWeight: "",
  count: "",
});

const group = (unitWeight: string, count: string): FormRow => ({
  mode: "group",
  weight: "",
  unitWeight,
  count,
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

describe("成组录入 evaluateRow", () => {
  it("单份重量 × 份数做十进制乘法（BigInt 毫克）", () => {
    const r = evaluateRow(group("12.500", "8"));
    expect(r).toMatchObject({ ok: true, mg: 100000n, unitMg: 12500n, count: 8 });
  });

  it("0.001 × 3 = 0.003，不出现二进制浮点尾巴", () => {
    const r = evaluateRow(group("0.001", "3"));
    expect(r.ok && r.mg).toBe(3n);
  });

  it("乘积刚好达到存储精度边界 99999999999.999 g 时合法", () => {
    const r = evaluateRow(group("33333333333.333", "3"));
    expect(r.ok && r.mg).toBe(MAX_STORED_MG);
  });

  it("乘积超出边界 1 毫克即拒绝", () => {
    const r = evaluateRow(group("50000000000.000", "2"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("存储范围");
  });

  it("单份重量非法时拒绝", () => {
    expect(evaluateRow(group("0", "2"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("-1", "2"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("1.0001", "2"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("abc", "2"))).toMatchObject({ ok: false });
  });

  it("份数必须是 2–999 的整数", () => {
    expect(evaluateRow(group("10", "1"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("10", "0"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("10", "1000"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("10", "2.0"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("10", "abc"))).toMatchObject({ ok: false });
    expect(evaluateRow(group("10", ""))).toMatchObject({ ok: false });
    // 999 合法
    const r = evaluateRow(group("10", "999"));
    expect(r.ok && r.mg).toBe(9990000n);
  });

  it("单笔行按原方式工作", () => {
    const r = evaluateRow(single("1200.500"));
    expect(r.ok && r.mg).toBe(1200500n);
  });

  it("完全空白的行是占位行（成组两个字段都空）", () => {
    expect(isBlankRow(newSingleRow())).toBe(true);
    expect(isBlankRow(single("1"))).toBe(false);
    expect(isBlankRow(group("", ""))).toBe(true);
    expect(isBlankRow(group("1", ""))).toBe(false);
    expect(isBlankRow(group("", "2"))).toBe(false);
  });
});

describe("subtotalRowsMg", () => {
  it("忽略空白行并精确合计单笔与成组，非法行返回 null", () => {
    expect(subtotalRowsMg([single("1.001"), newSingleRow(), group("2.000", "3")])).toBe(
      7001n,
    );
    expect(subtotalRowsMg([group("1.0001", "2")])).toBeNull();
    expect(subtotalRowsMg([])).toBe(0n);
  });
});

describe("validateRows", () => {
  it("要求至少一笔领料", () => {
    const r = validateRows(empty());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.focus).toEqual({ kind: "issued", seq: 0 });
  });

  it("退料总量不得大于领料总量", () => {
    const rows = empty();
    rows.issued = [single("100.000")];
    rows.returned = [group("50.000", "2")]; // 100.000
    const equal = validateRows(rows);
    expect(equal.ok).toBe(true); // 相等允许

    rows.returned = [group("50.001", "2")]; // 100.002 > 100
    const r = validateRows(rows);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.error).toContain("退料");
      expect(r.focus.kind).toBe("returned");
    }
  });

  it("定位到具体分区与行号（含空白占位行的界面下标）", () => {
    const rows = empty();
    rows.issued = [single("100"), newSingleRow(), single("0")];
    const r = validateRows(rows);
    expect(r).toMatchObject({ ok: false, error: "领料 第 2 笔：必须大于零" });
    if (!r.ok) expect(r.focus).toEqual({ kind: "issued", seq: 2 });
  });

  it("成组非法时错误指向分区和行，并区分单份/份数字段", () => {
    const rows = empty();
    rows.issued = [single("100"), group("10", "1000")];
    const r = validateRows(rows);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.error).toBe("领料 第 2 笔：份数必须在 2 与 999 之间");
      expect(r.focus).toEqual({ kind: "issued", seq: 1 });
    }
  });

  it("单笔与成组混合返回毫克行与合计", () => {
    const rows = empty();
    rows.issued = [single("1000.000"), group("12.500", "8")]; // 1100
    rows.returned = [group("10.000", "5")]; // 50
    rows.product = [single("1040.000")];
    rows.scrap = [single("60.000")];
    const r = validateRows(rows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.weights.issued).toEqual([1000000n, 100000n]);
      expect(r.totals.issued).toBe(1100000n);
      expect(r.totals.returned).toBe(50000n);
      // 净投入 1050，产出 1100，差额 +50，不闭合
      const rec = reckonMg(r.totals);
      expect(rec.differenceMg).toBe(50000n);
      expect(rec.closed).toBe(false);
    }
  });
});
