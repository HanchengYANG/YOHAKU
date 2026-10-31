import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import Markdown from "react-markdown";
import { chatMarkdownOptions } from "../chat-markdown.mjs";
import { availableChatGroups, createChatSession, visibleChatMessages } from "../chat-history.mjs";
import useChatSheet from "../use-chat-sheet.mjs";
import { sendChat } from "../chat-stream.mjs";
import useStreamedReply from "../use-streamed-reply.mjs";

const operationNames = { translation: "翻译", grammar: "解释语法", custom: "自定义问题", followup: "追问" };
const scopeKey = (ids) => ids?.length ? "groups:" + [...ids].sort().join(",") : "all";
const safeSource = (source) => {
  const url = typeof source === "string" ? source : source?.url;
  try { return /^https?:$/.test(new URL(url).protocol) ? url : null; } catch { return null; }
};

export default function DocumentChat({ document, open, onOpen, onClose, session: suppliedSession, request, navigation, onDocumentChanged, onRequestHandled, onBusyChange }) {
  const [session] = useState(() => suppliedSession || createChatSession());
  const [conversation, setConversation] = useState(null);
  const [groupId, setGroupId] = useState(session.groupId);
  const [scopeGroupIds, setScopeGroupIds] = useState(session.scopeGroupIds);
  const [drafts, setDrafts] = useState(session.drafts);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [answerPhase,setAnswerPhase] = useState("queued");
  const [sendingIntent, setSendingIntent] = useState(() => session.failedIntent ? {...session.failedIntent,navigation:0} : null);
  const [error, setError] = useState(session.failedIntent?.error || "");
  const [menuOpen, setMenuOpen] = useState(false);
  const generation = useRef(0), pending = useRef(null), handled = useRef(null), noticed = useRef(null);
  const messageArea = useRef(null), composer = useRef(null), moreButton = useRef(null), moreMenu = useRef(null);
  const conversationRef = useRef(null), scopeGroupsRef = useRef(scopeGroupIds), navigationVersion = useRef(0);
  const openRef = useRef(open), loadingRef = useRef(loading), renderedView = useRef(null), visibleLast = useRef(false), followEnd = useRef(false);
  openRef.current = open; loadingRef.current = loading;
  scopeGroupsRef.current = scopeGroupIds; conversationRef.current = conversation;
  const pendingSelection = sendingIntent?.selection && sendingIntent.navigation === navigationVersion.current ? sendingIntent : null;
  const viewKey = pendingSelection ? "request:" + pendingSelection.key : scopeKey(scopeGroupIds);
  const currentView = useRef(viewKey); currentView.current = viewKey;
  const groups = conversation?.groups || [];
  const followupGroups = availableChatGroups(groups, scopeGroupIds);
  const messages = useMemo(() => pendingSelection ? [] : visibleChatMessages(conversation?.messages, scopeGroupIds), [pendingSelection, conversation?.messages, scopeGroupIds]);
  const activeGroup = groups.find((group) => group.id === groupId);
  const panelId = "document-chat-" + document.id;
  const setTarget = (next) => {
    const value = typeof next === "function" ? next(session.groupId) : next;
    session.groupId = value; setGroupId(value);
  };
  const setScope = (ids) => {
    session.scopeGroupIds = ids; scopeGroupsRef.current = ids; setScopeGroupIds(ids);
    if (ids?.length) session.lastScope = ids;
  };
  const writeDraft = (id, text) => {
    if (!id) return;
    const next = { ...session.drafts };
    if (text) next[id] = text; else delete next[id];
    session.drafts = next; setDrafts(next);
  };
  const question = pendingSelection ? "" : drafts[groupId] || "";
  const captureView = () => {
    const area = messageArea.current;
    if (!area || !openRef.current || loadingRef.current || !renderedView.current) return;
    session.views.set(renderedView.current, {
      top: area.scrollTop,
      details: Array.from(area.querySelectorAll("details[open][data-chat-detail]")).map((element) => element.dataset.chatDetail),
    });
  };
  const stream = useStreamedReply((reply) => {
    captureView();
    const area = messageArea.current, ids = scopeGroupsRef.current;
    followEnd.current = openRef.current && (!ids?.length || ids.includes(reply.groupId)) && area && area.scrollTop + area.clientHeight >= area.scrollHeight-40;
  });
  const liveReply = stream.reply;
  const liveVisible = !pendingSelection && liveReply?.groupId && (!scopeGroupIds?.length || scopeGroupIds.includes(liveReply.groupId));
  const restoreView = () => {
    const area = messageArea.current;
    if (!area) return;
    const saved = session.views.get(currentView.current);
    area.querySelectorAll("details[data-chat-detail]").forEach((element) => {
      element.open = saved?.details.includes(element.dataset.chatDetail) || false;
    });
    area.scrollTop = saved ? saved.top : area.scrollHeight;
  };
  const close = () => { captureView(); setMenuOpen(false); composer.current?.blur(); onClose(); };
  const sheet = useChatSheet({ open, onOpen, onClose:close, onPreview:restoreView });
  const keepCurrentTarget = (nextGroups) => {
    const available = availableChatGroups(nextGroups, scopeGroupsRef.current);
    setTarget(available.some((group) => group.id === session.groupId) ? session.groupId : available.at(-1)?.id || null);
  };

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    api(`/documents/${encodeURIComponent(document.id)}/conversations`, { signal:controller.signal })
      .then((result) => {
        if (current !== generation.current) return;
        const item = result.conversations?.[0] || null;
        const validScope = scopeGroupsRef.current?.filter((id) => item?.groups?.some((group) => group.id === id));
        setScope(validScope?.length ? validScope : null);
        setConversation(item); keepCurrentTarget(item?.groups);
      }).catch((cause) => { if (cause.name !== "AbortError" && current === generation.current) setError(cause.message); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; controller.abort(); pending.current?.abort(); pending.current = null; onBusyChange?.(false); };
  }, [document.id, onBusyChange]);
  useLayoutEffect(() => () => captureView(), []);

  useLayoutEffect(() => {
    if (!navigation || navigation.documentId !== document.id || navigation.key === session.lastNavigationKey) return;
    captureView(); navigationVersion.current++; session.lastNavigationKey = navigation.key;
    session.failedIntent = null; setSendingIntent((intent) => intent?.failed ? null : intent); setError("");
    const ids = navigation.groupIds?.length ? navigation.groupIds : null;
    setScope(ids);
    setTarget((previous) => ids?.includes(previous) ? previous : ids?.[0] || previous);
  }, [navigation]);
  useLayoutEffect(() => {
    if (request && noticed.current !== request.key) {
      captureView(); noticed.current = request.key; navigationVersion.current++;
      session.failedIntent = null; setSendingIntent((intent) => intent?.failed ? null : intent);
    }
  }, [request]);
  useLayoutEffect(() => {
    if (loading) { visibleLast.current = false; return; }
    if (open) {
      if (!visibleLast.current || renderedView.current !== viewKey) restoreView();
      else if (followEnd.current) messageArea.current.scrollTop = messageArea.current.scrollHeight;
    }
    renderedView.current = viewKey; visibleLast.current = open; followEnd.current = false;
  }, [open, loading, viewKey, conversation?.messages?.length, sending, liveReply]);
  useLayoutEffect(() => {
    const input = composer.current;
    if (!open || !input) return;
    input.style.height = "44px";
    input.style.height = Math.min(110, Math.max(44, input.scrollHeight + 2)) + "px";
  }, [question, open, groupId]);
  useEffect(() => {
    if (!open) setMenuOpen(false);
  }, [open]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event) => {
      if (!moreMenu.current?.contains(event.target) && !moreButton.current?.contains(event.target)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [menuOpen]);

  const applyConversation = (result, intent, previous, navigationAtSend) => {
    captureView();
    const area = messageArea.current;
    followEnd.current = openRef.current && area && area.scrollTop + area.clientHeight >= area.scrollHeight - 40;
    setConversation(result);
    if (intent.selection && navigationAtSend === navigationVersion.current) {
      const oldIds = new Set(previous?.groups?.map((group) => group.id));
      const created = result?.groups?.find((group) => !oldIds.has(group.id));
      if (created) {
        const saved = session.views.get(currentView.current);
        if (saved) session.views.set(scopeKey([created.id]), saved);
        setTarget(created.id); setScope([created.id]);
        return created.id;
      } else keepCurrentTarget(result?.groups);
    } else keepCurrentTarget(result?.groups);
  };
  const send = async (intent) => {
    if (pending.current || loading) return;
    captureView(); followEnd.current = true;
    if (sheet.mobile && openRef.current) sheet.closeButton.current?.focus({preventScroll:true});
    const controller = new AbortController(); pending.current = controller;
    onBusyChange?.(true);
    const current = generation.current, navigationAtSend = navigationVersion.current;
    const previous = conversationRef.current, targetGroupId = session.groupId;
    const submitted = intent.selection ? "" : intent.question;
    let retainedFailure = false, streamedGroupId = intent.selection ? null : targetGroupId, streamedQuestion = intent.question, beforeAnswer = previous?.messages?.length || 0;
    session.failedIntent = null;
    stream.clear(); setAnswerPhase("queued");
    stream.update({key:crypto.randomUUID(),groupId:intent.selection ? null : targetGroupId,question:intent.question,operation:intent.operation || "followup",text:""});
    setSending(true); setError(""); setSendingIntent({ ...intent, navigation:navigationAtSend });
    if (!intent.selection) writeDraft(targetGroupId, "");
    try {
      const result = await sendChat(intent.selection
        ? `/documents/${encodeURIComponent(document.id)}/conversations`
        : `/conversations/${encodeURIComponent(previous.id)}/messages`, {
        signal:controller.signal,
        body:JSON.stringify(intent.selection
          ? {selection:intent.selection,operation:intent.operation,question:intent.question}
          : { groupId:targetGroupId, question:intent.question, operation:intent.operation || "followup" }),
        onEvent:(event) => {
          if (current !== generation.current || pending.current !== controller) return;
          if (event.type === "status") setAnswerPhase(event.phase);
          if (event.type === "delta" || event.type === "text") {
            setAnswerPhase("answering");
            stream.update((reply) => ({...reply,text:event.type === "text" ? event.text : reply.text + event.delta}));
          }
          if (event.type === "start") {
            streamedGroupId = event.groupId; streamedQuestion = event.question; beforeAnswer = event.conversation.messages.length;
            captureView(); setConversation(event.conversation);
            stream.update((reply) => ({...reply,groupId:event.groupId,question:event.question,operation:event.operation}));
            if (intent.selection && navigationAtSend === navigationVersion.current) {
              const saved = session.views.get(currentView.current);
              if (saved) session.views.set(scopeKey([event.groupId]),saved);
              setTarget(event.groupId); setScope([event.groupId]); setSendingIntent(null);
            }
          }
        },
      });
      if (current !== generation.current) return;
      applyConversation(result, intent, previous, navigationAtSend);
      stream.clear(); setAnswerPhase("done");
      try { await onDocumentChanged?.(); }
      catch { if (current === generation.current) setError("对话已保存，原文标记暂未刷新。可稍后重新打开文章。"); }
    } catch (cause) {
      if (current === generation.current && cause.name !== "AbortError") {
        stream.interrupt();
        setError(cause.message);
        if (submitted && !session.drafts[targetGroupId]) writeDraft(targetGroupId, submitted);
        try { await onDocumentChanged?.(); } catch { /* Keep the request error visible. */ }
        let createdId;
        try {
          const saved = await api(`/documents/${encodeURIComponent(document.id)}/conversations`);
          if (current === generation.current) {
            const restored = saved.conversations?.[0] || null;
            createdId = applyConversation(restored, intent, previous, navigationAtSend);
            const added = restored?.messages?.slice(beforeAnswer) || [];
            const completed = added.some((message,index) => message.role === "assistant" && message.groupId === streamedGroupId &&
              added[index-1]?.role === "user" && added[index-1]?.content === streamedQuestion);
            if (completed) { stream.clear(); setError(""); writeDraft(streamedGroupId, ""); }
            else if (createdId && intent.question) writeDraft(createdId, intent.question);
          }
        } catch { /* The last loaded conversation remains available offline. */ }
        if (intent.selection && !createdId && navigationAtSend === navigationVersion.current) {
          retainedFailure = true;
          session.failedIntent = {...intent,navigation:navigationAtSend,failed:true,error:cause.message};
          setSendingIntent(session.failedIntent);
        }
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (current === generation.current) { setSending(false); onBusyChange?.(false); if (!retainedFailure) setSendingIntent(null); }
    }
  };
  useEffect(() => {
    if (!request || loading || handled.current === request.key) return;
    handled.current = request.key;
    if (!pending.current) send(request);
    onRequestHandled?.();
  }, [request, loading]);

  const toggleScope = () => {
    captureView(); navigationVersion.current++;
    if (scopeGroupIds?.length) setScope(null);
    else {
      const ids = session.lastScope?.filter((id) => groups.some((group) => group.id === id));
      const next = ids?.length ? ids : groupId ? [groupId] : null;
      if (next) { setScope(next); setTarget(next.includes(groupId) ? groupId : next[0]); }
    }
  };
  const chooseTarget = (id) => { captureView(); setTarget(id); };
  const remove = async () => {
    if (!conversation || !window.confirm("删除这篇文章的全部对话记录？正文中的问答标记也会一并清理。")) return;
    setMenuOpen(false); setError("");
    try {
      await api(`/conversations/${encodeURIComponent(conversation.id)}`, { method:"DELETE" });
      generation.current++; pending.current?.abort(); pending.current = null;
      onBusyChange?.(false);
      session.drafts = {}; session.views.clear(); session.lastScope = null;
      session.failedIntent = null;
      stream.clear();
      setDrafts({}); setSending(false); setSendingIntent(null); setConversation(null); setTarget(null); setScope(null);
      await onDocumentChanged?.();
    } catch (cause) { setError(cause.message); }
    finally { moreButton.current?.focus({preventScroll:true}); }
  };
  const scoped = !!scopeGroupIds?.length || !!pendingSelection;
  const busy = sending || loading || !conversation || !groupId || !!pendingSelection;
  // Already completed Markdown should not be parsed again for every new letter.
  const renderedMessages = useMemo(() => messages.map((message, index) => {
    const groupIndex = groups.findIndex((group) => group.id === message.groupId), key = message.id || `${message.groupId || "legacy"}:${index}`;
    return <div className={`chat-message ${message.role}`} key={key} data-qa-group-id={message.groupId || undefined}>
      <span className="chat-speaker" title={message.createdAt ? new Date(message.createdAt).toLocaleString("zh-CN") : undefined}>
        {message.role === "user" ? "我" : "AI"}{!scopeGroupIds && ` · ${groupIndex >= 0 ? `问答 ${groupIndex + 1}` : "历史记录"}`}</span>
      {message.role === "assistant" ? <div className="chat-markdown"><Markdown {...chatMarkdownOptions}>{message.content || ""}</Markdown></div> : <div className="chat-user-text">{message.content}</div>}
      {message.sources?.length > 0 && <details className="chat-answer-sources" data-chat-detail={"sources:" + key}><summary>参考来源</summary>
        <ul className="answer-sources" aria-label="回答来源">{message.sources.map((source, i) => {
          const url = safeSource(source);
          return url && <li key={`${url}:${i}`}><a href={url} target="_blank" rel="noreferrer">{source.title || source.label || url}</a></li>;
        })}</ul></details>}
    </div>;
  }), [messages, groups, scopeGroupIds]);
  return <>
    <button ref={sheet.handle} type="button" className="chat-reopen-handle" hidden={open}
      aria-label="上划恢复对话" aria-controls={panelId} aria-expanded="false"
      {...sheet.handleDrag} onClick={sheet.onHandleClick}><span aria-hidden="true" /></button>
    <section ref={sheet.panel} id={panelId} hidden={!open} inert={!open}
      className="document-chat chat-timeline-panel" role={sheet.mobile ? "dialog" : "region"}
      aria-modal={sheet.mobile && open ? "true" : undefined} aria-label="原文 AI 讨论"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) { event.stopPropagation(); setMenuOpen(false); moreButton.current?.focus(); }
        else sheet.onKeyDown(event);
      }}>
      <div className="chat-sheet-top" {...sheet.headerDrag}>
        <div className="chat-drag-handle" aria-hidden="true"><span /></div>
        <header className="document-chat-heading">
          <button ref={sheet.closeButton} className="icon-button chat-close" aria-label="关闭 AI 讨论" type="button" onClick={close}>
            <Icon name={sheet.mobile ? "chevron-down" : "close"} size={20} />
          </button>
          <h2>对话</h2>
          <button type="button" className="chat-history-scope" onClick={toggleScope} disabled={!!pendingSelection || !groups.length}
            aria-label={scoped ? "查看全部对话" : "查看当前片段"}>
            <span aria-hidden="true">{scoped ? "当前片段" : "全部对话"}</span><Icon name="swap" size={14} />
            <span className="sr-only" aria-live="polite">{scopeGroupIds?.length ? `此处关联 ${scopeGroupIds.length} 个问答组` : "全部对话 · 按原始顺序"}</span>
          </button>
          <button ref={moreButton} className="icon-button" type="button" aria-label="更多对话操作"
            aria-controls={panelId + "-menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><Icon name="more" /></button>
        </header>
      </div>
      {menuOpen && <div ref={moreMenu} id={panelId + "-menu"} className="chat-more-menu">
        <div className="chat-document-title"><small>当前文章</small><strong>{document.title}</strong></div>
        <button type="button" onClick={() => {
          setMenuOpen(false); const details = messageArea.current.querySelector(".chat-group-contexts");
          if (details) { details.open = true; messageArea.current.scrollTop = 0; details.querySelector("summary").focus({preventScroll:true}); }
        }}>查看引用原句</button>
        {conversation && <button className="chat-delete" type="button" onClick={remove}>删除文章对话</button>}
      </div>}
      <div ref={messageArea} className="chat-messages" aria-label="对话记录" aria-live="polite" aria-busy={sending} onScroll={captureView}>
        {error && <div className="stage2-error" role="alert">{error}
          {pendingSelection?.failed && <button className="text-button chat-retry" type="button" disabled={loading || sending} onClick={() => send(pendingSelection)}>重试</button>}
        </div>}
        {conversation?.lastError && !error && <div className="stage2-error" role="alert">上次回答未完成：{conversation.lastError}。可在对应问答组继续提问。</div>}
        {pendingSelection ? <>
          <details className="chat-group-contexts" data-chat-detail="references"><summary>{pendingSelection.selection.text.slice(0,32)} · 查看引用</summary>
            <blockquote lang="ja">{pendingSelection.selection.text}</blockquote></details>
          <div className="chat-message user"><span className="chat-speaker">我 · {operationNames[pendingSelection.operation]}</span>
            <div className="chat-user-text">{pendingSelection.question || (pendingSelection.operation === "translation" ? "翻译这个片段" : "解释这个片段的语法")}</div></div>
        </> : !loading && followupGroups.length > 0 && <details className="chat-group-contexts" aria-label="问答引用片段" data-chat-detail="references">
          <summary>{followupGroups.length === 1 ? (activeGroup?.selection?.text || activeGroup?.quote || "引用片段").slice(0,30) + " · 查看引用原句" : "引用片段与发送时的句子"}</summary>
          {followupGroups.map((group) => {
            const index = groups.findIndex((item) => item.id === group.id), snapshot = group.selection || group;
            return <section className={`qa-group ${groupId === group.id ? "active" : ""}`} key={group.id} data-qa-group-id={group.id}>
              <button type="button" className="qa-group-heading" aria-pressed={groupId === group.id} onClick={() => chooseTarget(group.id)}>
                问答 {index + 1} · {group.orphaned ? "游离／原文关联已删除" : group.quoteChanged ? "原引用文字已修改" : "已关联正文"}</button>
              <blockquote lang="ja">{snapshot.text || group.quote || "历史引用"}</blockquote>
              {snapshot.sentences?.length > 0 && <details className="qa-snapshot" data-chat-detail={"sentences:" + group.id}><summary>发送时的句子</summary>
                {snapshot.sentences.map((sentence, i) => <p key={sentence.id || i} lang="ja">{sentence.text || sentence}</p>)}</details>}
            </section>;
          })}
        </details>}
        {loading ? <p className="chat-empty">正在读取对话…</p> : messages.length ? renderedMessages : !pendingSelection && !liveVisible && <div className="chat-empty"><p>{scopeGroupIds ? "这处片段还没有已完成的问答。" : "在正文中选中想讨论的字词。"}</p>
          <small>{scopeGroupIds ? "可在下方继续追问，或查看全部对话。" : "选择翻译、解释语法或自定义问题后，这里会保存本篇文章的问答。"}</small></div>}
        {liveVisible && <>
          <div className="chat-message user" data-qa-group-id={liveReply.groupId}><span className="chat-speaker">我 · {operationNames[liveReply.operation]}</span><div className="chat-user-text">{liveReply.question}</div></div>
          {liveReply.text && <div className="chat-message assistant" data-qa-group-id={liveReply.groupId} data-stream-state={liveReply.incomplete ? "incomplete" : "streaming"} aria-label={liveReply.incomplete ? "AI 未完成的回答" : "AI 正在回答"}>
            <span className="chat-speaker">AI{liveReply.incomplete ? " · 未完成" : ""}</span>
            <div className="chat-markdown"><Markdown {...chatMarkdownOptions}>{liveReply.text}</Markdown></div>
          </div>}
        </>}
        {sending && answerPhase !== "done" && <div className="chat-waiting" role="status" aria-label="AI回答进度">{answerPhase === "queued" ? "正在等待回答…" : answerPhase === "searching" ? "正在查找资料…" : answerPhase === "preparing" ? "正在准备回答…" : "正在回答…"}</div>}
      </div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); if (question.trim() && groupId && !busy) send({question:question.trim()}); }}>
        {!pendingSelection && followupGroups.length > 1 && <label className="chat-followup-target"><span>追问</span>
          <select aria-label="追问目标" value={groupId || ""} disabled={loading} onChange={(event) => chooseTarget(event.target.value)}>
            {followupGroups.map((group) => <option key={group.id} value={group.id}>问答 {groups.findIndex((item) => item.id === group.id) + 1} · {(group.selection?.text || group.quote || "历史引用").slice(0,35)}{group.orphaned ? "（游离）" : ""}</option>)}
          </select></label>}
        <div className="chat-input-row">
          <textarea ref={composer} aria-label="向 AI 提问" value={question} maxLength={4000} rows={1} disabled={busy}
            placeholder={groupId ? "继续问这个片段…" : "选中原文片段开始提问"} onChange={(event) => writeDraft(groupId,event.target.value)} />
          <button type="submit" className="button primary chat-send" aria-label="发送问题" disabled={busy || !question.trim()}><Icon name="send" /></button>
        </div>
      </form>
    </section>
  </>;
}
