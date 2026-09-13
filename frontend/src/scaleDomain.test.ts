import { describe, expect, it } from "vitest";
import {
  SCALE_TOLERANCE_MG,
  emptyScalePoints,
  evaluateScalePoint,
  findDuplicateScaleCheck,
  instantDeviation,
  isValidDateString,
  validateScaleDraft,
  type ScaleDraft,
} from "./scaleDomain";

const point = (standard: string, measured: string) => ({ standard, measured });

const draft = (
  deviceNo: string,
  checkDate: string,
  points: ReturnType<typeof point>[],
): ScaleDraft => ({ deviceNo, checkDate, points });

describe("秤检十进制定点规则", () => {
  it("偏差 = 实测 − 标准，带符号，精确到三位小数（毫克整数）", () => {
    const plus = evaluateScalePoint(point("1000.000", "1000.300"), 1);
    expect(plus.ok && plus.computed.deviationMg).toBe(300n);
    const minus = evaluateScalePoint(point("500.000", "499.700"), 1);
    expect(minus.ok && minus.computed.deviationMg).toBe(-300n);
    const zero = evaluateScalePoint(point("200.000", "200.000"), 1);
    expect(zero.ok && zero.computed.deviationMg).toBe(0n);
  });

  it("不出现二进制浮点尾巴（0.1+0.2 类输入仍精确）", () => {
    const r = evaluateScalePoint(point("0.100", "0.400"), 1);
    expect(r.ok && r.computed.deviationMg).toBe(300n);
    expect(instantDeviation(point("0.100", "0.400"))).toBe("+0.300");
  });

  it("临界偏差：|偏差| 恰好 0.500 g 合格，超过 1 毫克即超差", () => {
    expect(SCALE_TOLERANCE_MG).toBe(500n);
    const edgePlus = evaluateScalePoint(point("100.000", "100.500"), 1);
    expect(edgePlus.ok && edgePlus.computed.within).toBe(true);
    const edgeMinus = evaluateScalePoint(point("100.000", "99.500"), 1);
    expect(edgeMinus.ok && edgeMinus.computed.within).toBe(true);
    const overPlus = evaluateScalePoint(point("100.000", "100.501"), 1);
    expect(overPlus.ok && overPlus.computed.within).toBe(false);
    const overMinus = evaluateScalePoint(point("100.000", "99.499"), 1);
    expect(overMinus.ok && overMinus.computed.within).toBe(false);
  });

  it("标准/实测字段非正、超三位小数或非十进制时逐字段报错", () => {
    expect(evaluateScalePoint(point("0", "100"), 1)).toMatchObject({
      ok: false,
      error: { standard: "标准重量必须大于零" },
    });
    expect(evaluateScalePoint(point("-1", "100"), 1).ok).toBe(false);
    expect(evaluateScalePoint(point("100", "1.0001"), 1)).toMatchObject({
      ok: false,
      error: { measured: "实测重量最多三位小数" },
    });
    expect(evaluateScalePoint(point("abc", "100"), 1).ok).toBe(false);
    expect(evaluateScalePoint(point("", ""), 1).ok).toBe(false);
  });

  it("标准重量合法、实测非法时只报实测字段", () => {
    const r = evaluateScalePoint(point("100.000", "x"), 2);
    expect(r).toMatchObject({ ok: false, error: { measured: "实测重量必须是十进制数字" } });
  });
});

describe("isValidDateString", () => {
  it("只接受真实存在的 YYYY-MM-DD", () => {
    expect(isValidDateString("2026-09-13")).toBe(true);
    expect(isValidDateString("2026-2-3")).toBe(false);
    expect(isValidDateString("2026-02-30")).toBe(false); // 2 月没有 30 日
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("")).toBe(false);
    expect(isValidDateString("2026/09/13")).toBe(false);
  });
});

describe("validateScaleDraft", () => {
  const goodPoints = () => [
    point("1000.000", "1000.100"),
    point("500.000", "499.600"),
    point("200.000", "200.300"),
  ];

  it("三组都不超差时合格", () => {
    const r = validateScaleDraft(draft("DC-01", "2026-09-13", goodPoints()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.passed).toBe(true);
      expect(r.points.map((p) => p.deviationMg)).toEqual([100n, -400n, 300n]);
    }
  });

  it("任一点偏差超过 0.500 g 即不合格（单点超差）", () => {
    const points = goodPoints();
    points[1] = point("500.000", "500.501"); // +0.501
    const r = validateScaleDraft(draft("DC-01", "2026-09-13", points));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.passed).toBe(false);
  });

  it("临界：最大偏差恰好 ±0.500 g 合格", () => {
    const points = [
      point("100.000", "100.500"),
      point("100.000", "99.500"),
      point("100.000", "100.000"),
    ];
    const r = validateScaleDraft(draft("DC-01", "2026-09-13", points));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.passed).toBe(true);
  });

  it("设备编号为空时聚焦设备字段", () => {
    const r = validateScaleDraft(draft("  ", "2026-09-13", goodPoints()));
    expect(r).toMatchObject({ ok: false, deviceError: "设备编号不能为空" });
    if (!r.ok) expect(r.focus).toEqual({ field: "device" });
  });

  it("日期为空或非真实日历时聚焦日期字段", () => {
    const empty = validateScaleDraft(draft("DC-01", "", goodPoints()));
    expect(empty).toMatchObject({ ok: false, dateError: "检验日期不能为空" });
    if (!empty.ok) expect(empty.focus).toEqual({ field: "date" });

    const bad = validateScaleDraft(draft("DC-01", "2026-02-30", goodPoints()));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.dateError).toContain("日历日期");
      expect(bad.focus).toEqual({ field: "date" });
    }
  });

  it("逐测点逐字段报错并聚焦第一个出错测点", () => {
    const points = goodPoints();
    points[0] = point("0", "100");
    points[2] = point("100", "1.0001");
    const r = validateScaleDraft(draft("DC-01", "2026-09-13", points));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.pointErrors[0].standard).toContain("大于零");
      expect(r.pointErrors[1]).toEqual({});
      expect(r.pointErrors[2].measured).toContain("三位小数");
      expect(r.focus).toEqual({ point: 0, field: "standard" });
    }
  });

  it("第 1 测点标准合法、实测非法时聚焦该测点实测字段", () => {
    const points = goodPoints();
    points[0] = point("100.000", "x");
    const r = validateScaleDraft(draft("DC-01", "2026-09-13", points));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.focus).toEqual({ point: 0, field: "measured" });
  });

  it("空草稿：三个测点都缺字段，聚焦第 1 测点", () => {
    const r = validateScaleDraft(draft("DC-01", "2026-09-13", emptyScalePoints()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.focus).toEqual({ point: 0, field: "standard" });
  });
});

describe("findDuplicateScaleCheck", () => {
  const history = [
    { device_no: "DC-01", check_date: "2026-09-12" },
    { device_no: "DC-02", check_date: "2026-09-13" },
  ];

  it("同设备同日期才算重复", () => {
    expect(findDuplicateScaleCheck(history, "DC-01", "2026-09-12")).toBeDefined();
    expect(findDuplicateScaleCheck(history, " DC-01 ", "2026-09-12")).toBeDefined();
    expect(findDuplicateScaleCheck(history, "DC-01", "2026-09-13")).toBeUndefined();
    expect(findDuplicateScaleCheck(history, "DC-03", "2026-09-13")).toBeUndefined();
  });
});
