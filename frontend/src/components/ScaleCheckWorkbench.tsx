import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type ScaleCheck } from "../api";
import { formatGrams } from "../domain";
import {
  SCALE_POINT_COUNT,
  emptyScalePoints,
  evaluateScalePoint,
  findDuplicateScaleCheck,
  validateScaleDraft,
  type ScaleFieldError,
  type ScaleFocus,
  type ScalePointForm,
} from "../scaleDomain";

/** 单个测点的标准/实测输入与即时带符号偏差。 */
function PointRow({
  index,
  point,
  errors,
  onChange,
  registerRef,
}: {
  index: number;
  point: ScalePointForm;
  errors: ScaleFieldError;
  onChange: (next: ScalePointForm) => void;
  registerRef: (field: "standard" | "measured", el: HTMLInputElement | null) => void;
}) {
  const seq = index + 1;
  // 两字段都合法时即时显示带符号偏差；否则提示该测点尚未能核算
  const evalResult = evaluateScalePoint(point, seq);

  return (
    <tr className="scale-point" data-testid={`scale-point-${index}`}>
      <th>第 {seq} 测点</th>
      <td>
        <input
          ref={(el) => registerRef("standard", el)}
          aria-label={`第${seq}测点标准重量（克）`}
          data-testid={`scale-standard-${index}`}
          inputMode="decimal"
          className="weight-input"
          value={point.standard}
          placeholder="标准 0.000"
          onChange={(e) => onChange({ ...point, standard: e.target.value })}
        />
        {errors.standard && (
          <span className="field-error" data-testid={`scale-error-${index}-standard`}>
            {errors.standard}
          </span>
        )}
      </td>
      <td>
        <input
          ref={(el) => registerRef("measured", el)}
          aria-label={`第${seq}测点实测重量（克）`}
          data-testid={`scale-measured-${index}`}
          inputMode="decimal"
          className="weight-input"
          value={point.measured}
          placeholder="实测 0.000"
          onChange={(e) => onChange({ ...point, measured: e.target.value })}
        />
        {errors.measured && (
          <span className="field-error" data-testid={`scale-error-${index}-measured`}>
            {errors.measured}
          </span>
        )}
      </td>
      <td>
        <span
          className={
            evalResult.ok
              ? evalResult.computed.within
                ? "ok"
                : "bad"
              : "empty"
          }
          data-testid={`scale-deviation-${index}`}
          aria-live="polite"
        >
          {evalResult.ok
            ? `${formatGrams(evalResult.computed.deviationMg, true)} g`
            : "— g"}
        </span>
      </td>
      <td>
        {evalResult.ok ? (
          <span className={evalResult.computed.within ? "ok" : "bad"}>
            {evalResult.computed.within ? "不超差" : "超差"}
          </span>
        ) : (
          <span className="empty">—</span>
        )}
      </td>
    </tr>
  );
}

export function ScaleCheckWorkbench() {
  const [deviceNo, setDeviceNo] = useState("");
  const [checkDate, setCheckDate] = useState("");
  const [points, setPoints] = useState<ScalePointForm[]>(emptyScalePoints);
  const [history, setHistory] = useState<ScaleCheck[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [pointErrors, setPointErrors] = useState<ScaleFieldError[]>(
    () => Array.from({ length: SCALE_POINT_COUNT }, () => ({})),
  );
  const [lastSaved, setLastSaved] = useState<ScaleCheck | null>(null);
  // 每次提交递增，保证同一字段未修改再次提交时仍重新聚焦
  const focusAttempt = useRef(0);
  const [focusTick, setFocusTick] = useState<{ focus: ScaleFocus; attempt: number } | null>(
    null,
  );
  const deviceRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const pointRefs = useRef<(HTMLInputElement | null)[][]>(
    Array.from({ length: SCALE_POINT_COUNT }, () => [null, null]),
  );

  const refreshHistory = async () => {
    try {
      // 同一资源的查询契约：服务端按检验日期倒序返回
      setHistory(await api.listScaleChecks());
    } catch {
      setHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    void refreshHistory();
  }, []);

  // 三测点六字段全部合法时即时给出当次结论（本地十进制定点规则）
  const live = useMemo(
    () => validateScaleDraft({ deviceNo, checkDate, points }),
    [deviceNo, checkDate, points],
  );

  useEffect(() => {
    if (!focusTick) return;
    const { focus } = focusTick;
    if (focus.field === "device") {
      deviceRef.current?.focus();
    } else if (focus.field === "date") {
      dateRef.current?.focus();
    } else {
      const col = focus.field === "standard" ? 0 : 1;
      pointRefs.current[focus.point][col]?.focus();
    }
  }, [focusTick]);

  const registerPointRef =
    (index: number) =>
    (field: "standard" | "measured", el: HTMLInputElement | null) => {
      pointRefs.current[index][field === "standard" ? 0 : 1] = el;
    };

  const changePoint = (index: number, next: ScalePointForm) => {
    setPoints((prev) => prev.map((p, i) => (i === index ? next : p)));
    setPointErrors((prev) =>
      prev.map((e, i) => (i === index ? {} : e)),
    );
    setError(null);
  };

  const resetForm = () => {
    setDeviceNo("");
    setCheckDate("");
    setPoints(emptyScalePoints());
    setDeviceError(null);
    setDateError(null);
    setPointErrors(Array.from({ length: SCALE_POINT_COUNT }, () => ({})));
  };

  const submit = async () => {
    setError(null);
    setDeviceError(null);
    setDateError(null);
    setPointErrors(Array.from({ length: SCALE_POINT_COUNT }, () => ({})));

    // 提交前本地十进制校验（与后端规则一致）：非法时定位到设备/日期或具体测点字段
    const checked = validateScaleDraft({ deviceNo, checkDate, points });
    if (!checked.ok) {
      setDeviceError(checked.deviceError ?? null);
      setDateError(checked.dateError ?? null);
      setPointErrors(checked.pointErrors);
      focusAttempt.current += 1;
      setFocusTick({ focus: checked.focus, attempt: focusAttempt.current });
      return;
    }

    // 同设备同日期重复秤检：页面直接阻止重复提交（服务端唯一约束是最终裁决）
    const duplicate = findDuplicateScaleCheck(history, deviceNo, checkDate);
    if (duplicate) {
      const msg = `设备 ${duplicate.device_no} 在 ${duplicate.check_date} 已有秤检记录，每日只能保存一次`;
      setDateError(msg);
      focusAttempt.current += 1;
      setFocusTick({ focus: { field: "date" }, attempt: focusAttempt.current });
      return;
    }

    setSaving(true);
    try {
      const saved = await api.createScaleCheck({
        device_no: deviceNo.trim(),
        check_date: checkDate.trim(),
        points: checked.points.map((p) => ({
          // 提交规范化后的三位小数字符串，仍是十进制文本而非 number
          standard: formatGrams(p.standardMg),
          measured: formatGrams(p.measuredMg),
        })),
      });
      setLastSaved(saved);
      resetForm();
      // 以同一资源的查询契约恢复按日期倒序的台账
      await refreshHistory();
    } catch (e) {
      // 非法或重复请求被后端整体拒绝：当前输入保留，台账数量不变
      if (e instanceof ApiError && e.status === 409) {
        setDateError(e.message);
        focusAttempt.current += 1;
        setFocusTick({ focus: { field: "date" }, attempt: focusAttempt.current });
      } else {
        setError(e instanceof ApiError ? e.message : "提交失败，请重试");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="scale-workbench" aria-label="日常秤检工作台" data-testid="scale-workbench">
      <p className="hint">
        开工前用标准砝码确认示值：填写设备编号、检验日期与三组标准/实测重量，
        页面即时显示各组带符号偏差；提交后按“任一偏差绝对值不超过 0.500 克”判定合格。
        秤检台账独立保存，不参与也不阻断批次核算。
      </p>

      <div className="scale-meta">
        <div className={`scale-field${deviceError ? " field-invalid" : ""}`}>
          <label htmlFor="scale-device">设备编号</label>
          <input
            id="scale-device"
            ref={deviceRef}
            data-testid="scale-device"
            value={deviceNo}
            placeholder="例如 DC-03"
            onChange={(e) => {
              setDeviceNo(e.target.value);
              setDeviceError(null);
            }}
          />
          {deviceError && (
            <span className="field-error" data-testid="scale-device-error">
              {deviceError}
            </span>
          )}
        </div>
        <div className={`scale-field${dateError ? " field-invalid" : ""}`}>
          <label htmlFor="scale-date">检验日期</label>
          <input
            id="scale-date"
            ref={dateRef}
            type="date"
            data-testid="scale-date"
            value={checkDate}
            onChange={(e) => {
              setCheckDate(e.target.value);
              setDateError(null);
            }}
          />
          {dateError && (
            <span className="field-error" data-testid="scale-date-error">
              {dateError}
            </span>
          )}
        </div>
      </div>

      <table className="scale-points-table">
        <thead>
          <tr>
            <th>测点</th>
            <th>标准重量（克）</th>
            <th>实测重量（克）</th>
            <th>偏差（实测 − 标准）</th>
            <th>单点评定</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, i) => (
            <PointRow
              key={i}
              index={i}
              point={point}
              errors={pointErrors[i] ?? {}}
              onChange={(next) => changePoint(i, next)}
              registerRef={registerPointRef(i)}
            />
          ))}
        </tbody>
      </table>

      {live.ok ? (
        <p
          className={`verdict ${live.passed ? "verdict-closed" : "verdict-open"}`}
          data-testid="scale-preview-verdict"
        >
          即时判定：{live.passed ? "合格" : "不合格"}
          （{live.passed ? "三组偏差绝对值均不超过 0.500 g" : "存在偏差绝对值超过 0.500 g 的测点"}）
        </p>
      ) : (
        <p className="verdict scale-verdict-pending" data-testid="scale-preview-verdict">
          填写完整且全部合法后显示当次结论
        </p>
      )}

      {error && (
        <p className="error" role="alert" data-testid="scale-error">
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn-submit"
        data-testid="scale-submit"
        disabled={saving}
        onClick={() => void submit()}
      >
        {saving ? "提交中…" : "保存秤检记录"}
      </button>

      {lastSaved && (
        <section
          className="panel scale-result"
          aria-label="本次秤检结论"
          data-testid="scale-saved"
        >
          <h2>
            设备 {lastSaved.device_no}（{lastSaved.check_date}）本次结论
            <span
              className={`badge ${lastSaved.passed ? "badge-closed" : "badge-open"}`}
              data-testid="scale-saved-verdict"
            >
              {lastSaved.verdict}
            </span>
          </h2>
          <table className="history-table">
            <thead>
              <tr>
                <th>测点</th>
                <th>标准重量 (g)</th>
                <th>实测重量 (g)</th>
                <th>偏差 (g)</th>
              </tr>
            </thead>
            <tbody>
              {lastSaved.points.map((p) => (
                <tr key={p.seq}>
                  <td>第 {p.seq} 测点</td>
                  <td>{p.standard}</td>
                  <td>{p.measured}</td>
                  <td className={lastSaved.passed ? "ok" : "bad"}>{p.deviation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel history" aria-label="秤检台账">
        <h2>秤检台账（按检验日期倒序）</h2>
        {loadingHistory ? (
          <p>加载中…</p>
        ) : history.length === 0 ? (
          <p className="empty">还没有秤检记录</p>
        ) : (
          <table className="history-table" data-testid="scale-history">
            <thead>
              <tr>
                <th>设备编号</th>
                <th>检验日期</th>
                <th>三组标准重量 (g)</th>
                <th>三组实测重量 (g)</th>
                <th>三组偏差 (g)</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} data-testid={`scale-row-${r.id}`}>
                  <td>{r.device_no}</td>
                  <td>{r.check_date}</td>
                  <td>{r.points.map((p) => p.standard).join(" / ")}</td>
                  <td>{r.points.map((p) => p.measured).join(" / ")}</td>
                  <td className={r.passed ? "ok" : "bad"}>
                    {r.points.map((p) => p.deviation).join(" / ")}
                  </td>
                  <td>{r.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
