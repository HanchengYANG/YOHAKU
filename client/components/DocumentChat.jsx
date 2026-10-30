import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ImportProgress from "./ImportProgress.jsx";

const answerSteps = [{ id: "reply", label: "生成回答", copy: "正在结合当前句子和选中内容整理解释，可使用网页资料并展示来源。" }];
const operationNames = { translation: "翻译", grammar: "解释语法", custom: "自定义问题", followup: "追问" };
const safeSource = (source) => {
  const url = typeof source === "string" ? source : source?.url;
  try { return /^https?:$/.test(new URL(url).protocol) ? url : null; } catch { return null; }
};

export default function DocumentChat({ document, onClose, onDirty, request, selectedGroupIds, onDocumentChanged, onRequestHandled }) {
  const [conversation, setConversation] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = useRef(null);
  const handled = useRef(null);
  const bottom = useRef(null);
  const conversationRef = useRef(null);
  conversationRef.current = conversation;
  const groups = conversation?.groups || [];
  const activeGroup = groups.find((group) => group.id === groupId);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true); setConversation(null); setGroupId(null); setQuestion(""); setError(""); setSending(false);
    api(`/documents/${encodeURIComponent(document.id)}/conversations`, { signal: controller.signal })
      .then((result) => {
        if (current !== generation.current) return;
        const item = result.conversations?.[0] || null;
        setConversation(item); setGroupId(selectedGroupIds?.[0] || item?.groups?.at(-1)?.id || null);
      }).catch((error) => { if (error.name !== "AbortError") setError(error.message); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; controller.abort(); pending.current?.abort(); pending.current = null; };
  }, [document.id]);

  useEffect(() => {
    if (selectedGroupIds?.length) setGroupId(selectedGroupIds[0]);
  }, [selectedGroupIds]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [conversation?.messages?.length, sending]);

  const send = async (intent) => {
    if (pending.current || loading) return;
    const controller = new AbortController();
    pending.current = controller;
    const current = generation.current;
    setSending(true); setError(""); setStartedAt(performance.now());
    const currentConversation = conversationRef.current;
    try {
      const fresh = !!intent.selection;
      const result = await api(fresh
        ? `/documents/${encodeURIComponent(document.id)}/conversations`
        : `/conversations/${encodeURIComponent(currentConversation.id)}/messages`, {
        method: "POST", signal: controller.signal,
        body: JSON.stringify(fresh ? intent : { groupId, question: intent.question, operation: intent.operation || "followup" }),
      });
      if (current !== generation.current) return;
      setConversation(result);
      setGroupId(fresh ? result.groups?.at(-1)?.id : groupId);
      setQuestion(""); onDirty?.(false);
      await onDocumentChanged?.();
    } catch (error) {
      if (current === generation.current && error.name !== "AbortError") {
        setError(error.message);
        await onDocumentChanged?.().catch(() => {});
        try {
          const saved = await api(`/documents/${encodeURIComponent(document.id)}/conversations`);
          if (current === generation.current) { setConversation(saved.conversations?.[0] || null); setGroupId(saved.conversations?.[0]?.groups?.at(-1)?.id || null); }
        } catch { /* Keep the original failure visible while the server is unavailable. */ }
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (current === generation.current) setSending(false);
    }
  };
  useEffect(() => {
    if (!request || loading || sending || pending.current || handled.current === request.key) return;
    handled.current = request.key;
    send(request);
    onRequestHandled?.();
  }, [request, loading, sending]);

  const remove = async () => {
    if (!conversation || !window.confirm("删除这篇文章的全部对话记录？正文中的问答标记也会一并清理。")) return;
    setError("");
    try {
      await api(`/conversations/${encodeURIComponent(conversation.id)}`, { method: "DELETE" });
      // Invalidate in-flight answers before clearing the deleted conversation.
      generation.current++; pending.current?.abort(); pending.current = null;
      setSending(false); setConversation(null); setGroupId(null); setQuestion(""); onDirty?.(false);
      await onDocumentChanged?.();
    } catch (error) { setError(error.message); }
  };
  const close = () => {
    if (question.trim() && !window.confirm("这段问题还没有发送，确定离开吗？")) return;
    onDirty?.(false); onClose();
  };
  return <section className="document-chat" aria-label="原文 AI 讨论">
    <div className="document-chat-heading"><div><h2>对话记录</h2></div>
      <button className="icon-button" aria-label="关闭 AI 讨论" type="button" onClick={close}><Icon name="close" size={19} /></button>
    </div>
    <p className="chat-document-title">《{document.title}》</p>
    {error && <div className="stage2-error" role="alert">{error}</div>}
    {conversation?.lastError && !error && <div className="stage2-error" role="alert">上次回答未完成：{conversation.lastError}。可在对应问答组继续提问。</div>}
    {selectedGroupIds?.length > 1 && <div className="chat-linked-groups" role="group" aria-label="此处关联的问答组">
      <small>此处关联 {selectedGroupIds.length} 个问答组</small>
      {selectedGroupIds.map((id,index) => <button type="button" className="text-button" aria-pressed={groupId === id} key={id} onClick={() => setGroupId(id)}>问答 {groups.findIndex((group) => group.id === id)+1 || index+1}</button>)}
    </div>}
    <div className="chat-messages" aria-label="对话记录" aria-live="polite" aria-busy={sending}>
      {loading ? <p className="chat-empty">正在读取对话…</p> : groups.length ? groups.map((group, groupIndex) => {
        const snapshot = group.selection || group;
        const messages = (conversation.messages || []).filter((item) => item.groupId === group.id);
        return <section className={`qa-group ${groupId === group.id ? "active" : ""}`} key={group.id} data-qa-group-id={group.id}>
          <button type="button" className="qa-group-heading" aria-pressed={groupId === group.id} onClick={() => setGroupId(group.id)}>
            问答 {groupIndex + 1} · {group.orphaned ? "游离／原文关联已删除" : group.quoteChanged ? "原引用文字已修改" : "已关联正文"}
          </button>
          <blockquote lang="ja">{snapshot.text || group.quote || "历史引用"}</blockquote>
          {groupId === group.id && <div className="selection-actions">
            <button type="button" className="text-button" disabled={sending || loading} onClick={() => send({operation:"translation"})}>翻译此片段</button>
            <button type="button" className="text-button" disabled={sending || loading} onClick={() => send({operation:"grammar"})}>解释此片段语法</button>
          </div>}
          {snapshot.sentences?.length > 0 && <details className="qa-snapshot"><summary>发送时的句子</summary>{snapshot.sentences.map((sentence, i) => <p key={sentence.id || i} lang="ja">{sentence.text || sentence}</p>)}</details>}
          {messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${group.id}:${index}`}>
            <span className="chat-speaker">{message.role === "user" ? `我 · ${operationNames[message.operation] || "提问"}` : "AI"}</span>
            <div>{message.content}</div>
            {message.sources?.length > 0 && <ul className="answer-sources" aria-label="回答来源">{message.sources.map((source, i) => {
              const url = safeSource(source);
              return url && <li key={`${url}:${i}`}><a href={url} target="_blank" rel="noreferrer">{source.title || source.label || url}</a></li>;
            })}</ul>}
            {message.createdAt && <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString("zh-CN")}</time>}
          </div>)}
        </section>;
      }) : <div className="chat-empty"><p>在正文中选中想讨论的字词。</p><small>选择翻译、解释语法或自定义问题后，这里会保存本篇文章的问答。</small></div>}
      {conversation?.messages?.filter((message) => !message.groupId).map((message, index) => <div className={`chat-message ${message.role}`} key={`legacy:${index}`}><span className="chat-speaker">{message.role === "user" ? "我" : "AI"} · 历史记录</span><div>{message.content}</div></div>)}
      {sending && <ImportProgress label="AI回答进度" phase="reply" steps={answerSteps} startedAt={startedAt} />}
      <div ref={bottom} />
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); if(question.trim() && groupId) send({question:question.trim()}); }}>
      <fieldset disabled={sending || loading || !groupId}>
        <label className="stage2-field">{activeGroup ? "继续追问当前问答组" : "选择正文片段开始提问"}
          <textarea aria-label="向 AI 提问" value={question} maxLength={4000} placeholder="继续问这个片段…" onChange={(event) => { setQuestion(event.target.value); onDirty?.(!!event.target.value.trim()); }} />
        </label>
        <button type="submit" className="button primary" disabled={!question.trim() || !groupId}>{sending ? "正在回答…" : "发送问题"}</button>
      </fieldset>
    </form>
    {conversation && <button className="text-button chat-delete" type="button" onClick={remove}>删除文章对话</button>}
  </section>;
}
