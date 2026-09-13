import { KIND_LABEL, KINDS, type Kind } from "../domain";
import type { BatchDetail, BatchSummary } from "../api";
import { ComparePanel } from "./ComparePanel";

export interface DetailViewProps {
  detail: BatchDetail;
  /** 已保存批次列表，作为对比基准候选 */
  candidates: BatchSummary[];
}

/** 已保存批次的可复算详情：原始行、两侧合计、带符号差额、允许差、裁决与批次对比。 */
export function DetailView({ detail, candidates }: DetailViewProps) {
  return (
    <section className="panel detail" aria-label="批次核算详情" data-testid="batch-detail">
      <h2>
        批次 {detail.batch_no} 的核算详情
        <span
          className={`badge ${detail.closed ? "badge-closed" : "badge-open"}`}
          data-testid="detail-verdict"
        >
          {detail.verdict}
        </span>
      </h2>

      <div className="detail-grid">
        <div>
          <h3>投入侧</h3>
          <table>
            <tbody>
              <tr>
                <th>领料合计</th>
                <td data-testid="detail-issued-total">{detail.issued_total} g</td>
              </tr>
              <tr>
                <th>退料合计</th>
                <td>{detail.returned_total} g</td>
              </tr>
              <tr>
                <th>净投入 = 领料 − 退料</th>
                <td data-testid="detail-net">{detail.net_input} g</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <h3>产出侧</h3>
          <table>
            <tbody>
              <tr>
                <th>成品合计</th>
                <td>{detail.product_total} g</td>
              </tr>
              <tr>
                <th>废料合计</th>
                <td>{detail.scrap_total} g</td>
              </tr>
              <tr>
                <th>产出 = 成品 + 废料</th>
                <td>{detail.output_total} g</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <dl className="figures verdict-line">
        <dt>差额 = 产出 − 净投入</dt>
        <dd data-testid="detail-difference" className={detail.closed ? "ok" : "bad"}>
          {detail.difference} g
        </dd>
        <dt>允许差 max(5 g, ROUND_HALF_UP(净投入×0.2%))</dt>
        <dd data-testid="detail-tolerance">{detail.tolerance} g</dd>
      </dl>

      <h3>原始称重行（单位：克）</h3>
      <div className="raw-grid">
        {KINDS.map((kind: Kind) => (
          <div key={kind} data-testid={`raw-${kind}`}>
            <h4>{KIND_LABEL[kind]}</h4>
            {detail.entries[kind]?.length ? (
              <ol>
                {detail.entries[kind].map((e) =>
                  e.mode === "group" ? (
                    <li key={e.seq} data-testid={`raw-${kind}-${e.seq}-group`}>
                      第 {e.seq} 笔：{e.unit_weight} g × {e.count} 桶 ={" "}
                      <strong>{e.weight} g</strong>
                    </li>
                  ) : (
                    <li key={e.seq}>
                      第 {e.seq} 笔：{e.weight} g
                    </li>
                  ),
                )}
              </ol>
            ) : (
              <p className="empty">无</p>
            )}
          </div>
        ))}
      </div>

      <ComparePanel current={detail} candidates={candidates} />
    </section>
  );
}
