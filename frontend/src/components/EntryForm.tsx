import { useEffect, useMemo, useRef } from "react";
import {
  KIND_LABEL,
  type FormRow,
  type Kind,
  evaluateRow,
  formatGrams,
  isBlankRow,
  newSingleRow,
  parseGrams,
  reckonMg,
  subtotalRowsMg,
  validateRows,
} from "../domain";

export interface EntryFormProps {
  kind: Kind;
  rows: FormRow[];
  onChange: (next: FormRow[]) => void;
  /** 需要定位的出错行下标（0 起）；变化时滚动并聚焦对应输入 */
  errorSeq?: number | null;
}

/** 单个分区：每行可在单笔/成组两种录入方式间切换，可增删行。 */
export function EntryForm({ kind, rows, onChange, errorSeq = null }: EntryFormProps) {
  const label = KIND_LABEL[kind];

  const patch = (idx: number, patch: Partial<FormRow>) => {
    const next = rows.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };
  const update = (idx: number, value: string) => patch(idx, { weight: value });
  const switchMode = (idx: number, mode: FormRow["mode"]) => {
    const current = rows[idx];
    if (current.mode === mode) return;
    // 切到成组时，若单份留空则把单笔重量带过去，少敲一次相同数字
    const seed: Partial<FormRow> =
      mode === "group" && current.unitWeight.trim() === ""
        ? { unitWeight: current.weight }
        : {};
    patch(idx, { mode, ...seed });
  };
  const remove = (idx: number) => onChange(rows.filter((_, i) => i !== idx));
  const add = () => onChange([...rows, newSingleRow()]);

  const subtotal = useMemo(() => subtotalRowsMg(rows), [rows]);

  return (
    <section className={`panel panel-${kind}`} aria-label={`${label}分区`}>
      <h2>
        {label}
        <span className="unit">（单位：克）</span>
      </h2>
      <div className="rows">
        {rows.length === 0 && <p className="empty">暂无称重记录</p>}
        {rows.map((row, idx) => (
          <RowEditor
            key={idx}
            kind={kind}
            label={label}
            seq={idx}
            row={row}
            hasError={errorSeq === idx}
            onWeight={(v) => update(idx, v)}
            onUnit={(v) => patch(idx, { unitWeight: v })}
            onCount={(v) => patch(idx, { count: v })}
            onMode={(m) => switchMode(idx, m)}
            onRemove={() => remove(idx)}
          />
        ))}
      </div>
      <button type="button" className="btn-add" onClick={add}>
        + 添加一笔{label}
      </button>
      <p className="subtotal" data-testid={`subtotal-${kind}`}>
        小计：
        {subtotal === null ? "—" : `${formatGrams(subtotal)} g`}
      </p>
    </section>
  );
}

interface RowEditorProps {
  kind: Kind;
  label: string;
  seq: number;
  row: FormRow;
  hasError: boolean;
  onWeight: (v: string) => void;
  onUnit: (v: string) => void;
  onCount: (v: string) => void;
  onMode: (m: FormRow["mode"]) => void;
  onRemove: () => void;
}

function RowEditor({
  kind,
  label,
  seq,
  row,
  hasError,
  onWeight,
  onUnit,
  onCount,
  onMode,
  onRemove,
}: RowEditorProps) {
  const weightRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLInputElement>(null);
  const countRef = useRef<HTMLInputElement>(null);

  // 页面校验失败时定位到本行：滚动到可见并聚焦该方式下出错的输入
  useEffect(() => {
    if (!hasError) return;
    const target =
      row.mode === "single"
        ? weightRef.current
        : parseGrams(row.unitWeight).ok
          ? countRef.current
          : unitRef.current;
    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    target?.focus();
  }, [hasError, row.mode, row.unitWeight]);

  // 成组行即时显示十进制乘积（已填写且合法时）
  const groupEval = row.mode === "group" && !isBlankRow(row) ? evaluateRow(row) : null;

  return (
    <div className={`row row-${row.mode}${hasError ? " row-error" : ""}`}>
      <label className="row-label">第 {seq + 1} 笔</label>
      <div
        className="mode-switch"
        role="group"
        aria-label={`${label}第${seq + 1}笔录入方式`}
      >
        <label>
          <input
            type="radio"
            name={`mode-${kind}-${seq}`}
            checked={row.mode === "single"}
            onChange={() => onMode("single")}
          />
          单笔
        </label>
        <label>
          <input
            type="radio"
            name={`mode-${kind}-${seq}`}
            checked={row.mode === "group"}
            onChange={() => onMode("group")}
          />
          成组
        </label>
      </div>

      {row.mode === "single" ? (
        <div className="fields">
          <input
            ref={weightRef}
            aria-label={`${label}第${seq + 1}笔重量（克）`}
            data-kind={kind}
            data-seq={seq}
            inputMode="decimal"
            className="weight-input"
            value={row.weight}
            placeholder="0.000"
            onChange={(e) => onWeight(e.target.value)}
          />
          <span className="g">g</span>
        </div>
      ) : (
        <div className="fields group-fields">
          <input
            ref={unitRef}
            aria-label={`${label}第${seq + 1}笔单份重量（克）`}
            data-kind={kind}
            data-seq={seq}
            data-field="unit"
            inputMode="decimal"
            className="weight-input"
            value={row.unitWeight}
            placeholder="单份 0.000"
            onChange={(e) => onUnit(e.target.value)}
          />
          <span className="g">g ×</span>
          <input
            ref={countRef}
            aria-label={`${label}第${seq + 1}笔份数`}
            data-kind={kind}
            data-seq={seq}
            data-field="count"
            inputMode="numeric"
            className="count-input"
            value={row.count}
            placeholder="份数 2–999"
            onChange={(e) => onCount(e.target.value)}
          />
          <span className="g">桶</span>
          <span
            className={`adopted${groupEval && !groupEval.ok ? " adopted-error" : ""}`}
            data-testid={`adopted-${kind}-${seq}`}
            aria-live="polite"
          >
            ={" "}
            {groupEval?.ok
              ? `${formatGrams(groupEval.mg)} g`
              : groupEval
                ? groupEval.error
                : "— g"}
          </span>
        </div>
      )}
      <button type="button" className="link-danger" onClick={onRemove}>
        删除
      </button>
    </div>
  );
}

export interface ReckoningPanelProps {
  rowsByKind: Record<Kind, FormRow[]>;
}

/** 两侧合计、带符号差额、允许差与裁决的本地预览。 */
export function ReckoningPanel({ rowsByKind }: ReckoningPanelProps) {
  const parsed = validateRows(rowsByKind);

  if (!parsed.ok) {
    return (
      <section className="panel panel-result" aria-label="核算预览">
        <h2>核算预览</h2>
        <p className="invalid">当前输入尚不能核算：{parsed.error}</p>
      </section>
    );
  }

  const r = reckonMg(parsed.totals);
  return (
    <section className="panel panel-result" aria-label="核算预览">
      <h2>核算预览（本地十进制）</h2>
      <dl className="figures">
        <dt>领料合计</dt>
        <dd>{formatGrams(r.totalsMg.issued)} g</dd>
        <dt>退料合计</dt>
        <dd>{formatGrams(r.totalsMg.returned)} g</dd>
        <dt>净投入 = 领料 − 退料</dt>
        <dd>{formatGrams(r.netInputMg)} g</dd>
        <dt>成品合计</dt>
        <dd>{formatGrams(r.totalsMg.product)} g</dd>
        <dt>废料合计</dt>
        <dd>{formatGrams(r.totalsMg.scrap)} g</dd>
        <dt>产出 = 成品 + 废料</dt>
        <dd>{formatGrams(r.outputMg)} g</dd>
        <dt>差额 = 产出 − 净投入</dt>
        <dd data-testid="preview-difference" className={r.closed ? "ok" : "bad"}>
          {formatGrams(r.differenceMg, true)} g
        </dd>
        <dt>允许差 max(5 g, ROUND_HALF_UP(净投入×0.2%))</dt>
        <dd>{formatGrams(r.toleranceMg)} g</dd>
      </dl>
      <p
        className={`verdict ${r.closed ? "verdict-closed" : "verdict-open"}`}
        data-testid="preview-verdict"
      >
        预览裁决：{r.closed ? "闭合" : "不闭合"}
      </p>
    </section>
  );
}
