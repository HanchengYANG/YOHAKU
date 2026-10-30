export default function ReadingPreparation({ document, error = "", onRetry, onEdit, onBack }) {
  return <section className="reading-preparation" aria-label="准备阅读" aria-busy={!error}>
    <span className="eyebrow">准备阅读</span>
    <h1>{document?.title || "正在读取资料…"}</h1>
    <h2>{error ? "分句尚未完成" : "正在完成全文分句"}</h2>
    {error ? <p className="reading-preparation-error" role="alert">{error}</p> : <>
      <p role="status">请稍候，分句完成后会自动显示正文。</p>
      <div className="reading-preparation-progress" role="progressbar" aria-label="正在分句" aria-valuetext="正在等待全文分句完成"><span /></div>
    </>}
    <div className="reading-preparation-actions">
      {error && onRetry && <button className="button primary" type="button" onClick={onRetry}>重试分句</button>}
      {document && onEdit && <button className="button secondary" type="button" onClick={onEdit}>校对文字与注音</button>}
      {onBack && <button className="button subtle" type="button" onClick={onBack}>返回书架</button>}
    </div>
  </section>;
}
