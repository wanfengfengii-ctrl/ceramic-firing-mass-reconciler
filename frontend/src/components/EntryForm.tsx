import { useMemo } from "react";
import {
  KIND_LABEL,
  type Kind,
  formatGrams,
  reckonMg,
  subtotalMg,
  validateAndParse,
} from "../domain";

export interface EntryFormProps {
  kind: Kind;
  values: string[];
  onChange: (next: string[]) => void;
}

/** 单个分区：多笔十进制克重录入，可增删行。 */
export function EntryForm({ kind, values, onChange }: EntryFormProps) {
  const update = (idx: number, value: string) => {
    const next = values.slice();
    next[idx] = value;
    onChange(next);
  };
  const remove = (idx: number) => onChange(values.filter((_, i) => i !== idx));
  const add = () => onChange([...values, ""]);

  const subtotal = useMemo(() => subtotalMg(values), [values]);

  return (
    <section className={`panel panel-${kind}`} aria-label={`${KIND_LABEL[kind]}分区`}>
      <h2>
        {KIND_LABEL[kind]}
        <span className="unit">（单位：克）</span>
      </h2>
      <div className="rows">
        {values.length === 0 && <p className="empty">暂无称重记录</p>}
        {values.map((value, idx) => (
          <div className="row" key={idx}>
            <label className="row-label">第 {idx + 1} 笔</label>
            <input
              aria-label={`${KIND_LABEL[kind]}第${idx + 1}笔重量（克）`}
              data-kind={kind}
              data-seq={idx}
              inputMode="decimal"
              className="weight-input"
              value={value}
              placeholder="0.000"
              onChange={(e) => update(idx, e.target.value)}
            />
            <span className="g">g</span>
            <button type="button" className="link-danger" onClick={() => remove(idx)}>
              删除
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn-add" onClick={add}>
        + 添加一笔{KIND_LABEL[kind]}
      </button>
      <p className="subtotal" data-testid={`subtotal-${kind}`}>
        小计：
        {subtotal === null ? "—" : `${formatGrams(subtotal)} g`}
      </p>
    </section>
  );
}

export interface ReckoningPanelProps {
  rowsByKind: Record<Kind, string[]>;
}

/** 两侧合计、带符号差额、允许差与裁决的本地预览。 */
export function ReckoningPanel({ rowsByKind }: ReckoningPanelProps) {
  const parsed = validateAndParse(rowsByKind);

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
