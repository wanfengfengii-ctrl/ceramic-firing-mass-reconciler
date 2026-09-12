/**
 * 十进制克重核算（浏览器端预览用）。
 *
 * 裁决以后端 FastAPI + PostgreSQL 保存的结果为准；这里把所有重量
 * 放大为“毫克”整数（BigInt），全程不使用二进制浮点，保证预览一致。
 */

export type Kind = "issued" | "returned" | "product" | "scrap";
export const KINDS: Kind[] = ["issued", "returned", "product", "scrap"];

export type Parsed =
  | { ok: true; mg: bigint }
  | { ok: false; error: string };

const MILLIGRAMS_PER_GRAM = 1000n;
const TOLERANCE_FLOOR_MG = 5000n; // 5 克

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

/** 校验整批原始字符串行；返回解析值或第一个错误（含分区与行号）。 */
export function validateAndParse(
  rowsByKind: Record<Kind, string[]>,
):
  | { ok: true; weights: Record<Kind, bigint[]>; totals: Record<Kind, bigint> }
  | { ok: false; error: string } {
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
    // 空白项视为尚未录入的占位行，跳过；行号只数实际填写的行
    const filled = rowsByKind[kind]
      .map((raw) => raw.trim())
      .filter((raw) => raw !== "");
    for (let idx = 0; idx < filled.length; idx++) {
      const parsed = parseGrams(filled[idx]);
      if (!parsed.ok) {
        return {
          ok: false,
          error: `${KIND_LABEL[kind]} 第 ${idx + 1} 笔：${parsed.error}`,
        };
      }
      weights[kind].push(parsed.mg);
      totals[kind] += parsed.mg;
    }
  }

  if (weights.issued.length === 0) {
    return { ok: false, error: "领料至少需要一笔称重" };
  }
  if (totals.returned > totals.issued) {
    return { ok: false, error: "同批退料总量不得大于领料总量" };
  }
  return { ok: true, weights, totals };
}

export const KIND_LABEL: Record<Kind, string> = {
  issued: "领料",
  returned: "退料",
  product: "成品",
  scrap: "废料",
};

/** 只解析并合计单个分区（不套用整批规则）；任何一笔非法返回 null。 */
export function subtotalMg(values: string[]): bigint | null {
  let total = 0n;
  for (const raw of values) {
    const text = raw.trim();
    if (text === "") continue;
    const parsed = parseGrams(text);
    if (!parsed.ok) return null;
    total += parsed.mg;
  }
  return total;
}
