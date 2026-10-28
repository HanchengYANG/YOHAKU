import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ImportProgress from "./ImportProgress.jsx";

const answerSteps = [{ id: "reply", label: "生成回答", copy: "正在结合原文整理解释，回答完成后会自动显示。" }];

function readConversation(value) {
  if (
    typeof value?.id !== "string" ||
    !Array.isArray(value.messages) ||
    value.messages.some(
      (m) =>
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string",
    )
  )
    throw new Error("服务返回的对话内容无效，请重新打开讨论。");
  return value;
}

export default function DocumentChat({ document, onClose, onDirty }) {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [quote, setQuote] = useState("");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [answerStartedAt, setAnswerStartedAt] = useState(null);
  const [error, setError] = useState("");
  const bottom = useRef(null);
  const pending = useRef(null);
  const generation = useRef(0);
  const active = conversations.find((c) => c.id === activeId);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true);
    setConversations([]);
    setActiveId(null);
    setQuote("");
    setQuestion("");
    setSending(false);
    setAnswerStartedAt(null);
    setError("");
    api(`/documents/${encodeURIComponent(document.id)}/conversations`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!Array.isArray(result.conversations))
          throw new Error("对话列表无效，请重新打开讨论。");
        const items = result.conversations.map(readConversation);
        if (current !== generation.current) return;
        setConversations(items);
        setActiveId(items[0]?.id || null);
      })
      .catch((e) => {
        if (e.name !== "AbortError" && current === generation.current)
          setError(e.message);
      })
      .finally(() => {
        if (current === generation.current && !controller.signal.aborted)
          setLoading(false);
      });
    return () => {
      controller.abort();
      pending.current?.abort();
      pending.current = null;
      generation.current++;
    };
  }, [document.id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [activeId, active?.messages.length, sending]);

  const unsent = !!question.trim() || (!activeId && !!quote.trim());
  const mayLeave = () =>
    !sending && (!unsent || window.confirm("这段问题还没有发送，确定离开吗？"));
  const chooseConversation = (id) => {
    if (id === activeId || !mayLeave()) return;
    setActiveId(id || null);
    setQuote("");
    setQuestion("");
    setError("");
    onDirty?.(false);
  };
  const close = () => {
    if (!mayLeave()) return;
    onDirty?.(false);
    onClose();
  };
  const send = async (event) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || pending.current || loading) return;
    const controller = new AbortController();
    pending.current = controller;
    const current = generation.current;
    setSending(true);
    setAnswerStartedAt(performance.now());
    setError("");
    try {
      const result = await api(
        activeId
          ? `/conversations/${encodeURIComponent(activeId)}/messages`
          : `/documents/${encodeURIComponent(document.id)}/conversations`,
        {
          method: "POST",
          body: JSON.stringify(
            activeId
              ? { question: text }
              : { quote: quote.trim(), question: text },
          ),
          signal: controller.signal,
        },
      );
      const conversation = readConversation(result);
      if (current !== generation.current) return;
      setConversations((old) => [
        conversation,
        ...old.filter((c) => c.id !== conversation.id),
      ]);
      setActiveId(conversation.id);
      setQuestion("");
      setQuote("");
      onDirty?.(false);
    } catch (e) {
      if (current === generation.current && e.name !== "AbortError")
        setError(e.message);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (current === generation.current) setSending(false);
    }
  };

  return (
    <section className="document-chat" aria-label="原文 AI 讨论">
      <div className="document-chat-heading">
        <div>
          <span className="eyebrow">围绕原文，继续理解</span>
          <h2>与 AI 讨论</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭 AI 讨论"
          disabled={sending}
          onClick={close}
        >
          <Icon name="close" size={19} />
        </button>
      </div>
      <p className="chat-document-title">《{document.title}》</p>
      <div className="chat-thread-controls">
        <label className="stage2-field">
          已保存的讨论
          <select
            aria-label="选择已有讨论"
            value={activeId || ""}
            disabled={loading || sending}
            onChange={(e) => chooseConversation(e.target.value)}
          >
            <option value="">新的讨论</option>
            {conversations.map((c, index) => (
              <option key={c.id} value={c.id}>
                {(
                  c.quote ||
                  c.messages.find((m) => m.role === "user")?.content ||
                  `讨论 ${index + 1}`
                ).slice(0, 36)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button subtle"
          type="button"
          disabled={loading || sending || !activeId}
          onClick={() => chooseConversation(null)}
        >
          <Icon name="plus" size={15} />
          新讨论
        </button>
      </div>
      {error && (
        <div className="stage2-error" role="alert">
          {error}
        </div>
      )}
      {active?.quote && (
        <blockquote className="chat-context" lang="ja">
          {active.quote}
        </blockquote>
      )}
      <div
        className="chat-messages"
        aria-label="对话记录"
        aria-live="polite"
        aria-busy={sending}
      >
        {loading ? (
          <p className="chat-empty">正在读取讨论…</p>
        ) : active?.messages.length ? (
          active.messages.map((message, index) => (
            <div
              className={`chat-message ${message.role}`}
              key={`${active.id}:${index}`}
            >
              <span className="chat-speaker">
                {message.role === "user" ? "我" : "AI"}
              </span>
              <div>{message.content}</div>
            </div>
          ))
        ) : (
          <div className="chat-empty">
            <p>从一个没读懂的地方开始。</p>
            <small>
              可以问词义、语法或句子结构。解释会结合这篇原文的上下文。
            </small>
          </div>
        )}
        {sending && (
          <ImportProgress label="AI回答进度" phase="reply" steps={answerSteps} startedAt={answerStartedAt} />
        )}
        <div ref={bottom} />
      </div>
      <form className="chat-composer" onSubmit={send}>
        <fieldset disabled={sending || loading}>
          {!activeId && (
            <label className="stage2-field chat-quote-field">
              想讨论的原句 <span>可选，最多 6000 字；留空时结合全文</span>
              <textarea
                aria-label="想讨论的原句"
                lang="ja"
                value={quote}
                onChange={(e) => {
                  setQuote(e.target.value);
                  onDirty?.(!!e.target.value.trim() || !!question.trim());
                }}
                placeholder="可以在这里填入原文中的一个词或一句话"
                maxLength={6000}
                rows={2}
              />
            </label>
          )}
          <label className="stage2-field">
            {activeId ? "继续追问" : "你的问题"}
            <textarea
              aria-label="向 AI 提问"
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                onDirty?.(
                  !!e.target.value.trim() || (!activeId && !!quote.trim()),
                );
              }}
              placeholder={
                activeId
                  ? "继续问一个相关的问题…"
                  : "例如：这句话里的「わけにはいかない」是什么意思？"
              }
              maxLength={4000}
              rows={3}
              required
              onKeyDown={(e) => {
                if (
                  (e.ctrlKey || e.metaKey) &&
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </label>
          <div className="chat-send-row">
            <small>每次最多 4000 字，讨论会保留。</small>
            <button
              className="button primary"
              type="submit"
              disabled={!question.trim() || sending || loading}
            >
              {sending ? "正在回答…" : activeId ? "继续提问" : "发送问题"}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
