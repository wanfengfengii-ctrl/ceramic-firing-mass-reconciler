/**
 * 十进制克重核算（浏览器端预览用）。
 *
 * 裁决以后端 FastAPI + PostgreSQL 保存的结果为准；这里把所有重量
 * 放大为“毫克”整数（BigInt），全程不使用二进制浮点，保证预览一致。
 *
 * 每个称重分区支持两种行：
 * - 单笔行：直接填写一次称重的克重；
 * - 成组行：同规格匣钵/料桶连称，填“单份重量 × 份数”，份数为 2–999 的整数，
 *   页面立即乘出该行采用重量并带入小计与闭合预览。
 */

export type Kind = "issued" | "returned" | "product" | "scrap";
export const KINDS: Kind[] = ["issued", "returned", "product", "scrap"];

export type EntryMode = "single" | "group";

export interface FormRow {
  mode: EntryMode;
  /** 单笔重量（mode === "single" 时使用） */
  weight: string;
  /** 单份重量（mode === "group" 时使用，克） */
  unitWeight: string;
  /** 份数（2–999 的整数，文本态录入） */
  count: string;
}

export const newSingleRow = (): FormRow => ({
  mode: "single",
  weight: "",
  unitWeight: "",
  count: "",
});

export type Parsed =
  | { ok: true; mg: bigint }
  | { ok: false; error: string };

const MILLIGRAMS_PER_GRAM = 1000n;
const TOLERANCE_FLOOR_MG = 5000n; // 5 克

// 成组份数范围
export const MIN_GROUP_COUNT = 2;
export const MAX_GROUP_COUNT = 999;
// 与后端 Numeric(14,3) 对齐的存储上限：99999999999.999 g
export const MAX_STORED_MG = 99_999_999_999_999n;
export const MAX_STORED_GRAMS = "99999999999.999";

const DECIMAL_RE =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 把十进制克重文本解析为毫克整数：必须大于零、小数位不超过三位。 */
export function parseGrams(raw: string): Parsed {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "不能为空" };
  if (!DECIMAL_RE.test(text)) return { ok: false, error: "必须是十进制数字" };

  let body = text;
  let negative = false;
  if (body[0] === "+") body = body.slice(1);
  else if (body[0] === "-") {
    negative = true;
    body = body.slice(1);
  }

  let exp = 0;
  const eIndex = body.search(/[eE]/);
  if (eIndex >= 0) {
    exp = Number(body.slice(eIndex + 1));
    body = body.slice(0, eIndex);
  }

  const dot = body.indexOf(".");
  const intPart = dot >= 0 ? body.slice(0, dot) : body;
  const fracPart = dot >= 0 ? body.slice(dot + 1) : "";
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");

  // 最后一位数字相对小数点的指数 = exp - 小数位数；
  // 换算到毫克（10^-3）后必须仍是整数，否则小数位超过三位。
  const powerToMg = BigInt(exp - fracPart.length + 3);
  if (powerToMg < 0n) {
    return { ok: false, error: "最多三位小数" };
  }

  let mg = BigInt(digits || "0");
  for (let i = 0n; i < powerToMg; i++) mg *= 10n;
  if (negative) mg = -mg;
  if (mg <= 0n) return { ok: false, error: "必须大于零" };
  return { ok: true, mg };
}

/** 毫克整数格式化为三位小数克重。 */
export function formatGrams(mg: bigint, signed = false): string {
  const negative = mg < 0n;
  const abs = negative ? -mg : mg;
  const whole = abs / MILLIGRAMS_PER_GRAM;
  const frac = abs % MILLIGRAMS_PER_GRAM;
  const fracText = frac.toString().padStart(3, "0");
  const sign = negative ? "-" : signed ? "+" : "";
  return `${sign}${whole}.${fracText}`;
}

export interface Reckoning {
  totalsMg: Record<Kind, bigint>;
  netInputMg: bigint;
  outputMg: bigint;
  differenceMg: bigint;
  toleranceMg: bigint;
  closed: boolean;
}

/** ROUND_HALF_UP：净投入毫克 * 0.2% 后舍入到整数克，返回克数（整数）。 */
function roundedPercentGrams(netInputMg: bigint): bigint {
  // 结果克数 = 毫克 * 2/1000/1000 = 毫克*2/1_000_000；
  // 加 0.5 克（500_000 毫克）后整除，即对整数克做 HALF_UP。
  return (netInputMg * 2n + 500_000n) / 1_000_000n;
}

export function reckonMg(totals: Record<Kind, bigint>): Reckoning {
  const netInput = totals.issued - totals.returned;
  const output = totals.product + totals.scrap;
  const difference = output - netInput;
  const percent = roundedPercentGrams(netInput);
  const toleranceMg =
    percent * MILLIGRAMS_PER_GRAM > TOLERANCE_FLOOR_MG
      ? percent * MILLIGRAMS_PER_GRAM
      : TOLERANCE_FLOOR_MG;
  const absDiff = difference < 0n ? -difference : difference;
  return {
    totalsMg: totals,
    netInputMg: netInput,
    outputMg: output,
    differenceMg: difference,
    toleranceMg: toleranceMg,
    closed: absDiff <= toleranceMg,
  };
}

export const KIND_LABEL: Record<Kind, string> = {
  issued: "领料",
  returned: "退料",
  product: "成品",
  scrap: "废料",
};

/** 完全空白的行视为尚未录入的占位行（单笔空重量；成组两个字段都空）。 */
export function isBlankRow(row: FormRow): boolean {
  if (row.mode === "single") return row.weight.trim() === "";
  return row.unitWeight.trim() === "" && row.count.trim() === "";
}

export type RowEval =
  | { ok: true; mg: bigint; unitMg?: bigint; count?: number }
  | { ok: false; error: string };

/** 评估一行：单笔直接解析；成组解析单份、校验份数并做整数乘法。 */
export function evaluateRow(row: FormRow): RowEval {
  if (row.mode === "single") {
    const parsed = parseGrams(row.weight);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.mg > MAX_STORED_MG) {
      return { ok: false, error: `重量超出存储范围（≤ ${MAX_STORED_GRAMS} g）` };
    }
    return { ok: true, mg: parsed.mg };
  }

  const unitParsed = parseGrams(row.unitWeight);
  if (!unitParsed.ok) {
    return { ok: false, error: `单份重量${unitParsed.error}` };
  }
  if (unitParsed.mg > MAX_STORED_MG) {
    return { ok: false, error: `单份重量超出存储范围（≤ ${MAX_STORED_GRAMS} g）` };
  }

  const countText = row.count.trim();
  if (!/^\d+$/.test(countText)) {
    return { ok: false, error: `份数必须是 ${MIN_GROUP_COUNT}–${MAX_GROUP_COUNT} 的整数` };
  }
  const count = Number(countText);
  if (count < MIN_GROUP_COUNT || count > MAX_GROUP_COUNT) {
    return { ok: false, error: `份数必须在 ${MIN_GROUP_COUNT} 与 ${MAX_GROUP_COUNT} 之间` };
  }

  // 毫克（BigInt）× 整数份数：与后端 Decimal 乘法逐位相同，无二进制浮点
  const mg = unitParsed.mg * BigInt(count);
  if (mg > MAX_STORED_MG) {
    return {
      ok: false,
      error:
        `采用重量 ${formatGrams(mg)} g 超出存储范围` +
        `（${formatGrams(unitParsed.mg)} g × ${count}，上限 ${MAX_STORED_GRAMS} g）`,
    };
  }
  return { ok: true, mg, unitMg: unitParsed.mg, count };
}

/** 只合计单个分区的行（不套用整批规则）；任何一笔已填写行非法返回 null。 */
export function subtotalRowsMg(rows: FormRow[]): bigint | null {
  let total = 0n;
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const ev = evaluateRow(row);
    if (!ev.ok) return null;
    total += ev.mg;
  }
  return total;
}

export interface FocusTarget {
  kind: Kind;
  /** 行在界面上的下标（0 起，含占位行） */
  seq: number;
}

/**
 * 校验整批行；返回每行采用重量与分区合计，或第一个错误。
 * 错误信息含分区与行号，focus 指向界面中对应输入，供页面滚动/聚焦。
 */
export function validateRows(rowsByKind: Record<Kind, FormRow[]>):
  | { ok: true; weights: Record<Kind, bigint[]>; totals: Record<Kind, bigint> }
  | { ok: false; error: string; focus: FocusTarget } {
  const weights: Record<Kind, bigint[]> = {
    issued: [],
    returned: [],
    product: [],
    scrap: [],
  };
  const totals: Record<Kind, bigint> = {
    issued: 0n,
    returned: 0n,
    product: 0n,
    scrap: 0n,
  };

  for (const kind of KINDS) {
    let filledNo = 0;
    for (let idx = 0; idx < rowsByKind[kind].length; idx++) {
      const row = rowsByKind[kind][idx];
      if (isBlankRow(row)) continue;
      filledNo += 1;
      const ev = evaluateRow(row);
      if (!ev.ok) {
        return {
          ok: false,
          error: `${KIND_LABEL[kind]} 第 ${filledNo} 笔：${ev.error}`,
          focus: { kind, seq: idx },
        };
      }
      weights[kind].push(ev.mg);
      totals[kind] += ev.mg;
      if (totals[kind] > MAX_STORED_MG) {
        return {
          ok: false,
          error: `${KIND_LABEL[kind]}合计 ${formatGrams(totals[kind])} g 超出存储范围` +
            `（≤ ${MAX_STORED_GRAMS} g）`,
          focus: { kind, seq: idx },
        };
      }
    }
  }

  if (weights.issued.length === 0) {
    return {
      ok: false,
      error: "领料至少需要一笔称重",
      focus: { kind: "issued", seq: 0 },
    };
  }
  if (totals.returned > totals.issued) {
    // 定位到退料分区第一笔
    const firstReturned = rowsByKind.returned.findIndex((r) => !isBlankRow(r));
    return {
      ok: false,
      error: "同批退料总量不得大于领料总量",
      focus: { kind: "returned", seq: Math.max(firstReturned, 0) },
    };
  }
  return { ok: true, weights, totals };
}
