import ErrorNotice from "./ErrorNotice.mjs";

// Older articles without sources are segmented once before reading. The
// title, the way back and the correction entry are in ReadingBar above.
export default function ReadingPreparation({ error = "", onRetry }) {
  return <section className="reading-preparation" aria-label="准备阅读" aria-busy={!error}>
    {error ? <ErrorNotice error={error} message="准备失败" /> : <>
      <p role="status">正在准备</p>
      <div className="reading-preparation-progress" role="progressbar" aria-label="正在准备" aria-valuetext="正在准备"><span /></div>
    </>}
    <div className="reading-preparation-actions">
      {error && onRetry && <button className="button primary" type="button" onClick={onRetry}>重试分句</button>}
    </div>
  </section>;
}
