import { useEffect, useRef, useState } from "react";
import { EntryForm, ReckoningPanel } from "./components/EntryForm";
import { DetailView } from "./components/DetailView";
import { ImportPreviewPanel } from "./components/ImportPreview";
import {
  KINDS,
  type FocusTarget,
  type FormRow,
  type Kind,
  isBlankRow,
  newSingleRow,
  validateRows,
} from "./domain";
import type { EntryIn, EntryOut, ImportPreviewResponse } from "./api";
import { ApiError, api, type BatchDetail, type BatchSummary } from "./api";

type Rows = Record<Kind, FormRow[]>;

const emptyRows = (): Rows => ({
  issued: [newSingleRow()],
  returned: [newSingleRow()],
  product: [newSingleRow()],
  scrap: [newSingleRow()],
});

/** 预检返回的规范化行 → 录入页行对象（单笔/成组两种既有形态）。 */
function entryToFormRow(entry: EntryOut): FormRow {
  if (entry.mode === "group" && entry.unit_weight != null && entry.count != null) {
    return {
      mode: "group",
      weight: "",
      unitWeight: entry.unit_weight,
      count: String(entry.count),
    };
  }
  return { mode: "single", weight: entry.weight, unitWeight: "", count: "" };
}

interface PendingImport extends ImportPreviewResponse {
  filename: string;
}

/** 读取文件 UTF-8 文本：优先 Blob.text()，老环境回退 FileReader。 */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsText(file, "utf-8");
  });
}

export default function App() {
  const [rows, setRows] = useState<Rows>(emptyRows);
  const [batchNo, setBatchNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 当前错误定位到的分区/行；attempt 随每次提交递增，
  // 保证同一行未修改再次提交时也重新滚动并聚焦对应输入
  const [errorFocus, setErrorFocus] = useState<(FocusTarget & { attempt: number }) | null>(
    null,
  );
  const submitAttempt = useRef(0);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [list, setList] = useState<BatchSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  // 称重文件导入：预检结果在确认前只是待替换方案，
  // 批次号、已手工填写的内容与最近一次核算详情都保持不动
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importDone, setImportDone] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

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

  const changeRows = (kind: Kind, next: FormRow[]) => {
    setRows((r) => ({ ...r, [kind]: next }));
    setErrorFocus(null);
    setImportDone(null);
  };

  /** 选择称重文件：读取 UTF-8 文本并调用预检接口；失败时表单与详情均不动。 */
  const pickImportFile = async (file: File) => {
    setImportError(null);
    setImportDone(null);
    setPendingImport(null);
    setImporting(true);
    try {
      const content = await readFileText(file);
      const result = await api.importPreview(content);
      setPendingImport({ ...result, filename: file.name });
    } catch (e) {
      // 预检失败只提示行号与原因：当前表单、批次号与最近一次核算详情都不丢失
      setImportError(
        e instanceof ApiError ? `导入预检失败：${e.message}` : "导入预检失败，请重试",
      );
    } finally {
      setImporting(false);
      // 允许再次选择同一文件（change 事件需要值变化才触发）
      if (importFileRef.current) importFileRef.current.value = "";
    }
  };

  /** 确认导入：预检的规范化行整体替换四个分区的录入，批次号保持不变。 */
  const confirmImport = () => {
    if (!pendingImport) return;
    const next = emptyRows();
    for (const kind of KINDS) {
      next[kind] = pendingImport.entries[kind].map(entryToFormRow);
    }
    setRows(next);
    setPendingImport(null);
    setImportError(null);
    setError(null);
    setErrorFocus(null);
    setImportDone(`已导入 ${pendingImport.row_count} 行，请核对预览后提交保存`);
  };

  /** 取消导入：丢弃待替换方案，手工填写的内容原样保留。 */
  const cancelImport = () => {
    setPendingImport(null);
    setImportError(null);
  };

  const submit = async () => {
    setError(null);
    setErrorFocus(null);
    // 待确认的导入方案与提交动作互斥：以当前表单为准
    setPendingImport(null);
    setImportError(null);
    setImportDone(null);

    if (!batchNo.trim()) {
      setError("请先填写批次号");
      return;
    }

    // 提交前本地十进制校验（与后端规则一致）；非法时定位到分区与行号
    const checked = validateRows(rows);
    if (!checked.ok) {
      setError(checked.error);
      submitAttempt.current += 1;
      setErrorFocus({ ...checked.focus, attempt: submitAttempt.current });
      return;
    }

    // 空白占位行不上送；单笔上送字符串，成组上送依据对象（乘积由后端重算）
    const entries = Object.fromEntries(
      KINDS.map((k): [Kind, EntryIn[]] => [
        k,
        rows[k]
          .filter((row) => !isBlankRow(row))
          .map((row) =>
            row.mode === "single"
              ? row.weight.trim()
              : {
                  mode: "group" as const,
                  unit_weight: row.unitWeight.trim(),
                  count: Number(row.count.trim()),
                },
          ),
      ]),
    ) as Record<Kind, EntryIn[]>;

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
          连续称量同规格匣钵/料桶时，可把某一切换为“成组”，按“单份重量 × 份数”录入。
          也可以直接导入窑边电子秤导出的称重 CSV，预检确认后再按现有方式提交保存。
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

      <div className="import-bar">
        <input
          ref={importFileRef}
          type="file"
          accept=".csv,text/csv"
          className="import-file"
          data-testid="import-file"
          aria-label="称重文件"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickImportFile(file);
          }}
        />
        <button
          type="button"
          className="btn-import"
          data-testid="import-open"
          disabled={importing}
          onClick={() => importFileRef.current?.click()}
        >
          {importing ? "预检中…" : "导入称重文件"}
        </button>
        <span className="hint-inline">
          接受含“分区、重量、单份重量、份数”列的 UTF-8 CSV；确认前不会改变当前录入
        </span>
      </div>

      {importError && (
        <p className="error" role="alert" data-testid="import-error">
          {importError}
        </p>
      )}
      {importDone && (
        <p className="ok" role="status" data-testid="import-done">
          {importDone}
        </p>
      )}

      {pendingImport && (
        <ImportPreviewPanel
          filename={pendingImport.filename}
          result={pendingImport}
          onConfirm={confirmImport}
          onCancel={cancelImport}
        />
      )}

      <div className="grid">
        {KINDS.map((kind) => (
          <EntryForm
            key={kind}
            kind={kind}
            rows={rows[kind]}
            onChange={(next) => changeRows(kind, next)}
            errorSeq={errorFocus?.kind === kind ? errorFocus.seq : null}
            errorAttempt={errorFocus?.kind === kind ? errorFocus.attempt : 0}
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

      {detail && <DetailView detail={detail} candidates={list} />}

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
