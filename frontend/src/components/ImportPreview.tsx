import { KIND_LABEL, KINDS } from "../domain";
import type { ImportPreviewResponse } from "../api";

export interface ImportPreviewPanelProps {
  /** 用户选择的文件名（仅展示，不上送后端） */
  filename: string;
  result: ImportPreviewResponse;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 称重文件预检结果：规范化行与四分区核算预览。
 * 确认前当前录入页（批次号与手工填写内容）保持原样；
 * 确认后各分区行被导入行整体替换，再按现有方式核对预览并提交。
 */
export function ImportPreviewPanel({
  filename,
  result,
  onConfirm,
  onCancel,
}: ImportPreviewPanelProps) {
  const p = result.preview;
  return (
    <section className="panel import-preview" aria-label="导入预检" data-testid="import-preview">
      <h2>
        导入预检：{filename}
        <span className="unit">（共 {result.row_count} 行，确认后替换当前四个分区的录入）</span>
      </h2>

      <div className="raw-grid">
        {KINDS.map((kind) => (
          <div key={kind} data-testid={`import-raw-${kind}`}>
            <h4>{KIND_LABEL[kind]}</h4>
            {result.entries[kind]?.length ? (
              <ol>
                {result.entries[kind].map((e) =>
                  e.mode === "group" ? (
                    <li key={e.seq} data-testid={`import-raw-${kind}-${e.seq}-group`}>
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

      <dl className="figures verdict-line">
        <dt>领料合计</dt>
        <dd data-testid="import-preview-issued">{p.issued_total} g</dd>
        <dt>退料合计</dt>
        <dd>{p.returned_total} g</dd>
        <dt>净投入 = 领料 − 退料</dt>
        <dd data-testid="import-preview-net">{p.net_input} g</dd>
        <dt>成品合计</dt>
        <dd>{p.product_total} g</dd>
        <dt>废料合计</dt>
        <dd>{p.scrap_total} g</dd>
        <dt>产出 = 成品 + 废料</dt>
        <dd>{p.output_total} g</dd>
        <dt>差额 = 产出 − 净投入</dt>
        <dd data-testid="import-preview-difference" className={p.closed ? "ok" : "bad"}>
          {p.difference} g
        </dd>
        <dt>允许差 max(5 g, ROUND_HALF_UP(净投入×0.2%))</dt>
        <dd data-testid="import-preview-tolerance">{p.tolerance} g</dd>
      </dl>
      <p
        className={`verdict ${p.closed ? "verdict-closed" : "verdict-open"}`}
        data-testid="import-preview-verdict"
      >
        预览裁决：{p.verdict}
      </p>

      <div className="import-actions">
        <button
          type="button"
          className="btn-import-confirm"
          data-testid="import-confirm"
          onClick={onConfirm}
        >
          确认导入并替换当前录入
        </button>
        <button
          type="button"
          className="btn-import-cancel"
          data-testid="import-cancel"
          onClick={onCancel}
        >
          取消，保留当前录入
        </button>
      </div>
    </section>
  );
}
