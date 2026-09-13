/** 后端 API 契约。重量全部为十进制字符串（克，三位小数），不存在 number 重量字段。 */

import type { Kind } from "./domain";

/** 单笔行：直接提交十进制字符串；成组行：提交录入方式 + 单份重量 + 份数。 */
export type EntryIn = string | GroupEntryIn;

export interface GroupEntryIn {
  mode: "group";
  unit_weight: string;
  count: number;
}

export interface EntryOut {
  seq: number;
  weight: string;
  // 旧记录与单笔行 mode 为 "single"（依据字段为 null）；group 时可还原算式
  mode?: "single" | "group" | null;
  unit_weight?: string | null;
  count?: number | null;
}

export interface BatchDetail {
  id: number;
  batch_no: string;
  closed: boolean;
  verdict: string;
  issued_total: string;
  returned_total: string;
  product_total: string;
  scrap_total: string;
  net_input: string;
  output_total: string;
  difference: string;
  tolerance: string;
  entries: Record<Kind, EntryOut[]>;
  created_at: string;
}

export interface BatchSummary {
  id: number;
  batch_no: string;
  closed: boolean;
  verdict: string;
  net_input: string;
  difference: string;
  tolerance: string;
  created_at: string;
}

export interface CompareSide {
  id: number;
  batch_no: string;
  closed: boolean;
  verdict: string;
}

/** 单个指标：双方快照值与带符号变化量（当前 − 基准），三位小数十进制字符串。 */
export interface MetricDelta {
  current: string;
  base: string;
  delta: string;
}

export interface BatchCompare {
  current: CompareSide;
  base: CompareSide;
  issued_total: MetricDelta;
  returned_total: MetricDelta;
  net_input: MetricDelta;
  product_total: MetricDelta;
  scrap_total: MetricDelta;
  output_total: MetricDelta;
  difference: MetricDelta;
  tolerance: MetricDelta;
  verdict_changed: boolean;
}

export interface BatchIn {
  batch_no: string;
  entries: Record<Kind, EntryIn[]>;
}

// ---------------------------------------------------------------------------
// 日常秤检台账（独立资源：与批次接口互不引用）
// ---------------------------------------------------------------------------

export interface ScalePointIn {
  standard: string;
  measured: string;
}

export interface ScalePointOut {
  seq: number;
  standard: string;
  measured: string;
  /** 实测 − 标准，带符号，固定三位小数字符串 */
  deviation: string;
}

export interface ScaleCheck {
  id: number;
  device_no: string;
  check_date: string; // YYYY-MM-DD
  points: ScalePointOut[];
  passed: boolean;
  verdict: string; // “合格” / “不合格”
  created_at: string;
}

export interface ScaleCheckIn {
  device_no: string;
  check_date: string;
  points: ScalePointIn[];
}

/** 导入预检的核算预览：与批次详情相同的十进制字段，不含身份信息。 */
export interface ImportReckoning {
  issued_total: string;
  returned_total: string;
  product_total: string;
  scrap_total: string;
  net_input: string;
  output_total: string;
  difference: string;
  tolerance: string;
  closed: boolean;
  verdict: string;
}

/** 合法称重文件的预检结果：规范化行（各分区按文件行序）+ 核算预览。 */
export interface ImportPreviewResponse {
  row_count: number;
  entries: Record<Kind, EntryOut[]>;
  preview: ImportReckoning;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** 导入预检 400 时给出的 CSV 行号（文件级错误为 null）；其它接口无此字段 */
    public line?: number | null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    let message = `请求失败（${resp.status}）`;
    let line: number | null = null;
    try {
      const body = (await resp.json()) as { detail?: string; line?: number | null };
      if (typeof body.detail === "string") message = body.detail;
      if (typeof body.line === "number") line = body.line;
    } catch {
      // 非 JSON 错误体时保留默认消息
    }
    throw new ApiError(resp.status, message, line);
  }
  return (await resp.json()) as T;
}

export const api = {
  list(): Promise<BatchSummary[]> {
    return request("/api/batches");
  },
  get(id: number): Promise<BatchDetail> {
    return request(`/api/batches/${id}`);
  },
  create(payload: BatchIn): Promise<BatchDetail> {
    return request("/api/batches", { method: "POST", body: JSON.stringify(payload) });
  },
  compare(id: number, baseId: number): Promise<BatchCompare> {
    return request(`/api/batches/${id}/compare?base_id=${baseId}`);
  },
  importPreview(content: string): Promise<ImportPreviewResponse> {
    return request("/api/batches/import-preview", {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  },
  listScaleChecks(): Promise<ScaleCheck[]> {
    return request("/api/scale-checks");
  },
  createScaleCheck(payload: ScaleCheckIn): Promise<ScaleCheck> {
    return request("/api/scale-checks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
