import { useEffect, useState } from "react";
import { EntryForm, ReckoningPanel } from "./components/EntryForm";
import { DetailView } from "./components/DetailView";
import { KINDS, type Kind } from "./domain";
import { ApiError, api, type BatchDetail, type BatchSummary } from "./api";

type Rows = Record<Kind, string[]>;

const emptyRows = (): Rows => ({
  issued: [""],
  returned: [""],
  product: [""],
  scrap: [""],
});

export default function App() {
  const [rows, setRows] = useState<Rows>(emptyRows);
  const [batchNo, setBatchNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [list, setList] = useState<BatchSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const refreshList = async () => {
    try {
      setList(await api.list());
    } catch {
      setList([]);
    } finally {
      setLoadingList(false);
    }
  };

  // 刷新页面后从 PostgreSQL 重新拉取，业务结果不变
  useEffect(() => {
    void refreshList();
  }, []);

  const submit = async () => {
    setError(null);
    const entries = Object.fromEntries(
      KINDS.map((k) => [k, rows[k].map((v) => v.trim()).filter(Boolean)]),
    ) as Record<Kind, string[]>;

    if (!batchNo.trim()) {
      setError("请先填写批次号");
      return;
    }
    setSaving(true);
    try {
      const saved = await api.create({ batch_no: batchNo.trim(), entries });
      setDetail(saved); // 合法超差批次照常保存，详情显示“不闭合”
      setRows(emptyRows());
      setBatchNo("");
      await refreshList();
    } catch (e) {
      // 非法批次被后端整体拒绝，不会留下任何记录
      setError(e instanceof ApiError ? e.message : "提交失败");
    } finally {
      setSaving(false);
    }
  };

  const openBatch = async (id: number) => {
    setError(null);
    try {
      setDetail(await api.get(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "读取失败");
    }
  };

  return (
    <main className="page">
      <header>
        <h1>试烧窑批次核算站</h1>
        <p className="hint">
          所有重量以十进制克（g）输入，最多三位小数且必须大于零；裁决仅使用十进制运算。
        </p>
      </header>

      <div className="batch-no">
        <label htmlFor="batch-no">批次号</label>
        <input
          id="batch-no"
          data-testid="batch-no"
          value={batchNo}
          onChange={(e) => setBatchNo(e.target.value)}
          placeholder="例如 K2026-0912-03"
        />
      </div>

      <div className="grid">
        {KINDS.map((kind) => (
          <EntryForm
            key={kind}
            kind={kind}
            values={rows[kind]}
            onChange={(next) => setRows((r) => ({ ...r, [kind]: next }))}
          />
        ))}
        <ReckoningPanel rowsByKind={rows} />
      </div>

      {error && (
        <p className="error" role="alert" data-testid="form-error">
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn-submit"
        data-testid="submit"
        disabled={saving}
        onClick={() => void submit()}
      >
        {saving ? "提交中…" : "提交核算并保存"}
      </button>

      {detail && <DetailView detail={detail} />}

      <section className="panel history" aria-label="已保存批次">
        <h2>已保存批次</h2>
        {loadingList ? (
          <p>加载中…</p>
        ) : list.length === 0 ? (
          <p className="empty">还没有已保存批次</p>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>批次号</th>
                <th>净投入 (g)</th>
                <th>差额 (g)</th>
                <th>允许差 (g)</th>
                <th>裁决</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} data-testid={`row-${b.id}`}>
                  <td>{b.batch_no}</td>
                  <td>{b.net_input}</td>
                  <td className={b.closed ? "ok" : "bad"}>{b.difference}</td>
                  <td>{b.tolerance}</td>
                  <td>{b.verdict}</td>
                  <td>
                    <button type="button" onClick={() => void openBatch(b.id)}>
                      查看可复算详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
