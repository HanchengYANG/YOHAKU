import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ImportProgress from "./ImportProgress.jsx";
import Markdown from "react-markdown";
import { chatMarkdownOptions } from "../chat-markdown.mjs";
import { availableChatGroups, visibleChatMessages } from "../chat-history.mjs";
import "../document-chat.css";

const answerSteps = [{ id: "reply", label: "生成回答", copy: "正在结合当前句子和选中内容整理解释，可使用网页资料并展示来源。" }];
const operationNames = { translation: "翻译", grammar: "解释语法", custom: "自定义问题", followup: "追问" };
const safeSource = (source) => {
  const url = typeof source === "string" ? source : source?.url;
  try { return /^https?:$/.test(new URL(url).protocol) ? url : null; } catch { return null; }
};

export default function DocumentChat({ document, onClose, onDirty, request, selectedGroupIds, onDocumentChanged, onRequestHandled }) {
  const [conversation, setConversation] = useState(null);
  const [groupId, setGroupId] = useState(null);
  const [scopeGroupIds, setScopeGroupIds] = useState(selectedGroupIds?.length ? selectedGroupIds : null);
  const [historyFocus, setHistoryFocus] = useState(0);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = useRef(null);
  const handled = useRef(null);
  const messageArea = useRef(null);
  const conversationRef = useRef(null);
  const scopeGroupsRef = useRef(scopeGroupIds);
  const navigationVersion = useRef(0);
  scopeGroupsRef.current = scopeGroupIds;
  conversationRef.current = conversation;
  const groups = conversation?.groups || [];
  const followupGroups = availableChatGroups(groups, scopeGroupIds);
  const messages = visibleChatMessages(conversation?.messages, scopeGroupIds);
  const activeGroup = groups.find((group) => group.id === groupId);
  const keepCurrentTarget = (nextGroups) => setGroupId((previous) => {
    const available = availableChatGroups(nextGroups, scopeGroupsRef.current);
    return available.some((group) => group.id === previous) ? previous : available.at(-1)?.id || null;
  });

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    const initialScope = selectedGroupIds?.length ? selectedGroupIds : null;
    scopeGroupsRef.current = initialScope; setScopeGroupIds(initialScope);
    setLoading(true); setConversation(null); setGroupId(null); setQuestion(""); setError(""); setSending(false);
    api(`/documents/${encodeURIComponent(document.id)}/conversations`, { signal: controller.signal })
      .then((result) => {
        if (current !== generation.current) return;
        const item = result.conversations?.[0] || null;
        const scope = scopeGroupsRef.current;
        setConversation(item); setScopeGroupIds(scope);
        setGroupId(availableChatGroups(item?.groups, scope).at(-1)?.id || null);
      }).catch((error) => { if (error.name !== "AbortError") setError(error.message); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; controller.abort(); pending.current?.abort(); pending.current = null; };
  }, [document.id]);

  useEffect(() => {
    const scope = selectedGroupIds?.length ? selectedGroupIds : null;
    navigationVersion.current++;
    scopeGroupsRef.current = scope;
    setScopeGroupIds(scope);
    setGroupId((previous) => !scope || scope.includes(previous) ? previous : scope[0]);
    setHistoryFocus((value) => value + 1);
  }, [selectedGroupIds]);
  useEffect(() => {
    const area = messageArea.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [conversation?.messages?.length, sending, scopeGroupIds, historyFocus]);

  const send = async (intent) => {
    if (pending.current || loading) return;
    const controller = new AbortController();
    pending.current = controller;
    const current = generation.current;
    const navigation = navigationVersion.current;
    setSending(true); setError(""); setStartedAt(performance.now());
    const currentConversation = conversationRef.current;
    const targetGroupId = groupId;
    try {
      const fresh = !!intent.selection;
      const result = await api(fresh
        ? `/documents/${encodeURIComponent(document.id)}/conversations`
        : `/conversations/${encodeURIComponent(currentConversation.id)}/messages`, {
        method: "POST", signal: controller.signal,
        body: JSON.stringify(fresh ? intent : { groupId: targetGroupId, question: intent.question, operation: intent.operation || "followup" }),
      });
      if (current !== generation.current) return;
      setConversation(result);
      if (fresh && navigation === navigationVersion.current) {
        const oldIds = new Set(currentConversation?.groups?.map((group) => group.id));
        const created = result.groups?.find((group) => !oldIds.has(group.id)) || result.groups?.at(-1);
        setGroupId(created?.id || null);
        scopeGroupsRef.current = created ? [created.id] : null;
        setScopeGroupIds(scopeGroupsRef.current);
      } else keepCurrentTarget(result.groups);
      setQuestion(""); onDirty?.(false);
      await onDocumentChanged?.();
    } catch (error) {
      if (current === generation.current && error.name !== "AbortError") {
        setError(error.message);
        await onDocumentChanged?.().catch(() => {});
        try {
          const saved = await api(`/documents/${encodeURIComponent(document.id)}/conversations`);
          if (current === generation.current) {
            const restored = saved.conversations?.[0] || null;
            setConversation(restored);
            if (intent.selection && navigation === navigationVersion.current) {
              const oldIds = new Set(currentConversation?.groups?.map((group) => group.id));
              const created = restored?.groups?.find((group) => !oldIds.has(group.id));
              if (created) { setGroupId(created.id); scopeGroupsRef.current = [created.id]; setScopeGroupIds(scopeGroupsRef.current); }
              else keepCurrentTarget(restored?.groups);
            } else keepCurrentTarget(restored?.groups);
          }
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
      setSending(false); setConversation(null); setGroupId(null); setScopeGroupIds(null); setQuestion(""); onDirty?.(false);
      await onDocumentChanged?.();
    } catch (error) { setError(error.message); }
  };
  const close = () => {
    if (question.trim() && !window.confirm("这段问题还没有发送，确定离开吗？")) return;
    onDirty?.(false); onClose();
  };
  return <section className="document-chat chat-timeline-panel" aria-label="原文 AI 讨论">
    <div className="document-chat-heading"><div><h2>对话记录</h2></div>
      <button className="icon-button" aria-label="关闭 AI 讨论" type="button" onClick={close}><Icon name="close" size={19} /></button>
    </div>
    <p className="chat-document-title">《{document.title}》</p>
    {error && <div className="stage2-error" role="alert">{error}</div>}
    {conversation?.lastError && !error && <div className="stage2-error" role="alert">上次回答未完成：{conversation.lastError}。可在对应问答组继续提问。</div>}
    <div className="chat-history-scope">
      <span aria-live="polite">{scopeGroupIds ? `此处关联 ${scopeGroupIds.length} 个问答组` : "全部对话 · 按原始顺序"}</span>
      {scopeGroupIds && <button type="button" className="text-button" onClick={() => { navigationVersion.current++; scopeGroupsRef.current = null; setScopeGroupIds(null); setHistoryFocus((value) => value + 1); }}>查看全部对话</button>}
    </div>
    <div ref={messageArea} className="chat-messages" aria-label="对话记录" aria-live="polite" aria-busy={sending}>
      {!loading && followupGroups.length > 0 && <details className="chat-group-contexts" aria-label="问答引用片段"><summary>引用片段与发送时的句子</summary>{followupGroups.map((group) => {
        const groupIndex = groups.findIndex((item) => item.id === group.id);
        const snapshot = group.selection || group;
        return <section className={`qa-group ${groupId === group.id ? "active" : ""}`} key={group.id} data-qa-group-id={group.id}>
          <button type="button" className="qa-group-heading" aria-pressed={groupId === group.id} onClick={() => setGroupId(group.id)}>
            问答 {groupIndex + 1} · {group.orphaned ? "游离／原文关联已删除" : group.quoteChanged ? "原引用文字已修改" : "已关联正文"}
          </button>
          <blockquote lang="ja">{snapshot.text || group.quote || "历史引用"}</blockquote>
          {snapshot.sentences?.length > 0 && <details className="qa-snapshot"><summary>发送时的句子</summary>{snapshot.sentences.map((sentence, i) => <p key={sentence.id || i} lang="ja">{sentence.text || sentence}</p>)}</details>}
        </section>;
      })}</details>}
      {loading ? <p className="chat-empty">正在读取对话…</p> : messages.length ? messages.map((message, index) => {
        const groupIndex = groups.findIndex((group) => group.id === message.groupId);
        return <div className={`chat-message ${message.role}`} key={message.id || `${message.groupId || "legacy"}:${index}`} data-qa-group-id={message.groupId || undefined}>
            <span className="chat-speaker">{message.role === "user" ? `我 · ${operationNames[message.operation] || "提问"}` : "AI"} · {groupIndex >= 0 ? `问答 ${groupIndex + 1}` : "历史记录"}</span>
            {message.role === "assistant" ? <div className="chat-markdown"><Markdown {...chatMarkdownOptions}>{message.content || ""}</Markdown></div> : <div className="chat-user-text">{message.content}</div>}
            {message.sources?.length > 0 && <ul className="answer-sources" aria-label="回答来源">{message.sources.map((source, i) => {
              const url = safeSource(source);
              return url && <li key={`${url}:${i}`}><a href={url} target="_blank" rel="noreferrer">{source.title || source.label || url}</a></li>;
            })}</ul>}
            {message.createdAt && <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString("zh-CN")}</time>}
          </div>;
      }) : <div className="chat-empty"><p>{scopeGroupIds ? "这处片段还没有已完成的问答。" : "在正文中选中想讨论的字词。"}</p><small>{scopeGroupIds ? "可在下方继续追问，或查看全部对话。" : "选择翻译、解释语法或自定义问题后，这里会保存本篇文章的问答。"}</small></div>}
      {sending && <ImportProgress label="AI回答进度" phase="reply" steps={answerSteps} startedAt={startedAt} />}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); if(question.trim() && groupId) send({question:question.trim()}); }}>
      <fieldset disabled={sending || loading || !groupId}>
        {followupGroups.length > 0 && <label className="chat-followup-target">追问目标
          <select aria-label="追问目标" value={groupId || ""} onChange={(event) => setGroupId(event.target.value)}>
            {followupGroups.map((group) => <option key={group.id} value={group.id}>问答 {groups.findIndex((item) => item.id === group.id) + 1} · {(group.selection?.text || group.quote || "历史引用").slice(0, 35)}{group.orphaned ? "（游离）" : ""}</option>)}
          </select>
        </label>}
        <label className="stage2-field">{activeGroup ? "继续追问当前问答组" : "选择正文片段开始提问"}
          <textarea aria-label="向 AI 提问" value={question} maxLength={4000} placeholder="继续问这个片段…" onChange={(event) => { setQuestion(event.target.value); onDirty?.(!!event.target.value.trim()); }} />
        </label>
        <button type="submit" className="button primary" disabled={!question.trim() || !groupId}>{sending ? "正在回答…" : "发送问题"}</button>
      </fieldset>
    </form>
    {conversation && <button className="text-button chat-delete" type="button" onClick={remove}>删除文章对话</button>}
  </section>;
}
