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

export interface BatchIn {
  batch_no: string;
  entries: Record<Kind, EntryIn[]>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    try {
      const body = (await resp.json()) as { detail?: string };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      // 非 JSON 错误体时保留默认消息
    }
    throw new ApiError(resp.status, message);
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
};
