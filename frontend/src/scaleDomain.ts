/**
 * 日常秤检的十进制定点规则（浏览器端即时预览用）。
 *
 * 与批次核算完全独立：结果不进入任何批次合计。标准重量与实测重量复用
 * parseGrams 的“正的三位小数克重 → 毫克整数（BigInt）”解析，全程不使用
 * 二进制浮点；偏差 = 实测 − 标准（毫克整数），三个测点偏差绝对值都不超过
 * 500 毫克（0.500 克）才判定合格。
 */

import { formatGrams, parseGrams } from "./domain";

export const SCALE_POINT_COUNT = 3;
/** 单测点允许偏差绝对值上限：0.500 克 = 500 毫克 */
export const SCALE_TOLERANCE_MG = 500n;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ScalePointForm {
  standard: string;
  measured: string;
}

export const emptyScalePoints = (): ScalePointForm[] =>
  Array.from({ length: SCALE_POINT_COUNT }, () => ({ standard: "", measured: "" }));

export interface ScalePointComputed {
  seq: number;
  standardMg: bigint;
  measuredMg: bigint;
  /** 实测 − 标准，带符号，毫克整数 */
  deviationMg: bigint;
  within: boolean;
}

export interface ScaleFieldError {
  standard?: string;
  measured?: string;
}

export interface ScaleDraft {
  deviceNo: string;
  checkDate: string;
  points: ScalePointForm[];
}

export type ScaleValidation =
  | {
      ok: true;
      points: ScalePointComputed[];
      passed: boolean;
    }
  | {
      ok: false;
      deviceError?: string;
      dateError?: string;
      pointErrors: ScaleFieldError[];
      /** 第一个错误聚焦目标（设备/日期或某个测点字段） */
      focus: ScaleFocus;
    };

export type ScaleFocus =
  | { field: "device" }
  | { field: "date" }
  | { point: number; field: "standard" | "measured" };

/** 校验日历日期真实存在（parseGrams 不管日期）。 */
export function isValidDateString(value: string): boolean {
  const text = value.trim();
  if (!DATE_RE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

/** 单个测点：两个字段都能解析时给出带符号偏差与是否超差。 */
export function evaluateScalePoint(
  point: ScalePointForm,
  seq: number,
): { ok: true; computed: ScalePointComputed } | { ok: false; error: ScaleFieldError } {
  const std = parseGrams(point.standard);
  if (!std.ok) return { ok: false, error: { standard: `标准重量${std.error}` } };
  const meas = parseGrams(point.measured);
  if (!meas.ok) return { ok: false, error: { measured: `实测重量${meas.error}` } };
  const deviationMg = meas.mg - std.mg;
  const abs = deviationMg < 0n ? -deviationMg : deviationMg;
  return {
    ok: true,
    computed: {
      seq,
      standardMg: std.mg,
      measuredMg: meas.mg,
      deviationMg,
      within: abs <= SCALE_TOLERANCE_MG,
    },
  };
}

/** 行内即时偏差：两字段均合法时返回带符号三位小数字符串，否则 null。 */
export function instantDeviation(point: ScalePointForm): string | null {
  const r = evaluateScalePoint(point, 1);
  return r.ok ? formatGrams(r.computed.deviationMg, true) : null;
}

/**
 * 校验整份秤检草稿：设备编号非空、日期为真实 YYYY-MM-DD、三组测点字段均为
 * 正的三位小数；错误逐测点逐字段返回，供页面在对应输入下明确反馈。
 */
export function validateScaleDraft(draft: ScaleDraft): ScaleValidation {
  const pointErrors: ScaleFieldError[] = [];
  let firstPointFocus: ScaleFocus | null = null;
  const computed: ScalePointComputed[] = [];

  for (let i = 0; i < SCALE_POINT_COUNT; i++) {
    const r = evaluateScalePoint(draft.points[i] ?? { standard: "", measured: "" }, i + 1);
    if (r.ok) {
      pointErrors.push({});
      computed.push(r.computed);
    } else {
      pointErrors.push(r.error);
      if (!firstPointFocus) {
        firstPointFocus = {
          point: i,
          field: r.error.standard !== undefined ? "standard" : "measured",
        };
      }
    }
  }

  const deviceError = draft.deviceNo.trim() === "" ? "设备编号不能为空" : undefined;
  const dateError =
    draft.checkDate.trim() === ""
      ? "检验日期不能为空"
      : isValidDateString(draft.checkDate)
        ? undefined
        : "检验日期必须是有效的日历日期（YYYY-MM-DD）";

  if (deviceError) return { ok: false, deviceError, pointErrors, focus: { field: "device" } };
  if (dateError) return { ok: false, dateError, pointErrors, focus: { field: "date" } };
  if (firstPointFocus) return { ok: false, pointErrors, focus: firstPointFocus };

  const passed = computed.every((p) => p.within);
  return { ok: true, points: computed, passed };
}

/** 同设备同日期重复秤检的本地预判（服务端唯一约束仍是最终裁决）。 */
export function findDuplicateScaleCheck(
  history: { device_no: string; check_date: string }[],
  deviceNo: string,
  checkDate: string,
): { device_no: string; check_date: string } | undefined {
  const device = deviceNo.trim();
  const date = checkDate.trim();
  return history.find((r) => r.device_no === device && r.check_date === date);
}
