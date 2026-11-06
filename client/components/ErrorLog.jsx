import { useEffect, useState } from "react";
import api from "../api.mjs";
import ErrorNotice from "./ErrorNotice.mjs";

export default function ErrorLog({ onClose }) {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [items, setItems] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [open, setOpen] = useState(null);
  const [details, setDetails] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async ({ append = false, search = searched } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("query", search.trim());
      if (append && nextBefore) params.set("before", nextBefore);
      const result = await api(`/admin/errors?${params}`);
      setItems((current) => (append ? [...current, ...result.items] : result.items));
      setNextBefore(result.nextBefore);
      setSearched(search);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (code) => {
    if (open === code) return setOpen(null);
    setOpen(code);
    if (details[code]) return;
    try {
      const entry = await api(`/admin/errors/${encodeURIComponent(code)}`);
      setDetails((current) => ({ ...current, [code]: entry }));
    } catch (cause) {
      setError(cause);
    }
  };

  return (
    <section className="stage2-page error-log" aria-label="错误记录">
      <div className="stage2-heading">
        <h1>错误记录</h1>
        <button type="button" className="button subtle" onClick={onClose}>返回</button>
      </div>
      <form className="error-log-search" onSubmit={(event) => { event.preventDefault(); load({ search: query }); }}>
        <input aria-label="错误代码" placeholder="粘贴错误代码" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="button secondary" disabled={busy}>查找</button>
      </form>
      <ErrorNotice error={error} />
      {!items.length && !busy && <p className="error-log-empty">没有记录</p>}
      <ol className="error-log-list">
        {items.map((item) => (
          <li key={item.code}>
            <button type="button" className="error-log-row" aria-expanded={open === item.code} onClick={() => toggle(item.code)}>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
              <code>{item.code}</code>
              <span>{item.username || "—"}</span>
              <span>{item.location || item.scope}</span>
              <span className="error-log-summary">{item.summary}</span>
            </button>
            {open === item.code && details[item.code] && (
              <div className="error-log-detail">
                <p>{details[item.code].message}</p>
                {details[item.code].stack && <pre>{details[item.code].stack}</pre>}
                <pre>{JSON.stringify(details[item.code].context, null, 2)}</pre>
              </div>
            )}
          </li>
        ))}
      </ol>
      {nextBefore && <button type="button" className="button secondary" disabled={busy} onClick={() => load({ append: true })}>更多</button>}
    </section>
  );
}
