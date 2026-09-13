import { useEffect, useState } from "react";
import {
  ApiError,
  api,
  type BatchCompare,
  type BatchDetail,
  type BatchSummary,
  type MetricDelta,
} from "../api";

export interface ComparePanelProps {
  /** 当前打开的批次详情 */
  current: BatchDetail;
  /** 已保存批次列表（基准候选；当前批次也在其中，用于自比拦截） */
  candidates: BatchSummary[];
}

type MetricKey =
  | "issued_total"
  | "returned_total"
  | "net_input"
  | "product_total"
  | "scrap_total"
  | "output_total"
  | "difference"
  | "tolerance";

const METRIC_ROWS: Array<{ key: MetricKey; label: string }> = [
  { key: "issued_total", label: "领料合计" },
  { key: "returned_total", label: "退料合计" },
  { key: "net_input", label: "净投入" },
  { key: "product_total", label: "成品合计" },
  { key: "scrap_total", label: "废料合计" },
  { key: "output_total", label: "产出合计" },
  { key: "difference", label: "差额" },
  { key: "tolerance", label: "允许差" },
];

/** 变化量着色：正为增、负为减、零不变（仅按符号，不评好坏）。 */
function deltaClass(delta: string): string {
  if (delta.startsWith("-")) return "delta-neg";
  // 零的规范渲染为 "+0.000"（后端不会出现 "-0.000"）
  return /^\+0+\.0+$/.test(delta) ? "delta-zero" : "delta-pos";
}

/** 与历史批次并排核对：选择基准后展示双方合计、差额、允许差、裁决及带符号变化量。 */
export function ComparePanel({ current, candidates }: ComparePanelProps) {
  const [baseId, setBaseId] = useState("");
  const [result, setResult] = useState<BatchCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 切换到另一批次详情时，对比区随之重置
  useEffect(() => {
    setBaseId("");
    setResult(null);
    setError(null);
  }, [current.id]);

  // 当前批次始终可选（用于演示/拦截自比），其余来自已保存列表
  const options = [
    { id: current.id, batch_no: current.batch_no, verdict: current.verdict },
    ...candidates.filter((b) => b.id !== current.id),
  ];

  const run = async () => {
    setResult(null);
    if (baseId === "") {
      setError("请先选择一个基准批次");
      return;
    }
    if (Number(baseId) === current.id) {
      // 与自身对比没有意义：页面直接阻止，不发起请求
      setError("基准批次不能是当前批次自身，请另选一个历史批次");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setResult(await api.compare(current.id, Number(baseId)));
    } catch (e) {
      // 保留当前详情与基准选择，可直接再次发起对比
      setError(e instanceof ApiError ? e.message : "对比读取失败，可直接重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="compare" aria-label="批次对比" data-testid="compare-panel">
      <h3>与历史批次对比</h3>
      <div className="compare-controls">
        <select
          aria-label="基准批次"
          data-testid="compare-base-select"
          value={baseId}
          onChange={(e) => setBaseId(e.target.value)}
        >
          <option value="">选择基准批次…</option>
          {options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.batch_no}（{b.verdict}）
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="compare-run"
          disabled={loading}
          onClick={() => void run()}
        >
          {loading ? "对比中…" : "发起对比"}
        </button>
      </div>

      {error && (
        <p className="error" role="alert" data-testid="compare-error">
          {error}
        </p>
      )}

      {result && (
        <div data-testid="compare-result">
          <p className="compare-summary" data-testid="compare-base-summary">
            当前批次 <strong>{result.current.batch_no}</strong>（{result.current.verdict}）对比基准批次 <strong>{result.base.batch_no}</strong>（{result.base.verdict}）
          </p>
          <p className="compare-verdict">
            裁决：
            {result.verdict_changed ? (
              <span className="bad" data-testid="compare-verdict-change">
                {result.base.verdict} → {result.current.verdict}（裁决发生变化）
              </span>
            ) : (
              <span data-testid="compare-verdict-change">
                均为{result.current.verdict}（无变化）
              </span>
            )}
          </p>
          <table className="compare-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>当前批次 (g)</th>
                <th>基准批次 (g)</th>
                <th>变化（当前 − 基准）</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_ROWS.map(({ key, label }) => {
                const m: MetricDelta = result[key];
                return (
                  <tr key={key} data-testid={`compare-row-${key}`}>
                    <th>{label}</th>
                    <td>{m.current}</td>
                    <td>{m.base}</td>
                    <td className={deltaClass(m.delta)} data-testid={`compare-delta-${key}`}>
                      {m.delta} g
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
