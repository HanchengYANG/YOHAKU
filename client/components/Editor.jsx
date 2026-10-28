import { useRef, useState } from "react";
import {
  parseText,
  plainText,
  serializeBlocks,
  stats,
  annotateBlocks,
  editPlainText,
} from "../../shared/document.mjs";
import { kinds } from "../constants.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";

export default function Editor({ initial, onSave, onCancel, onDirty, saving }) {
  const [value, setValue] = useState(initial);
  const [blocks, setBlocks] = useState(() =>
    parseText(initial.content, initial.blocks || []),
  );
  const [selection, setSelection] = useState(null);
  const [reading, setReading] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState("text");
  const textarea = useRef(null);
  const readingInput = useRef(null);
  const body = plainText(blocks);
  const counts = stats(blocks);
  const update = (patch) => {
    setValue((old) => ({ ...old, ...patch }));
    onDirty();
  };
  const updateBlocks = (next) => {
    setBlocks(next);
    setSelection(null);
    onDirty();
  };
  const editBody = (text) => {
    const result = editPlainText(blocks, text);
    updateBlocks(result.blocks);
    if (result.removed)
      setMessage(
        `正文变化影响了 ${result.removed} 处注音，已移除对应读音，请重新校正。`,
      );
  };
  const getSelection = () => {
    const el = textarea.current;
    if (el && el.selectionEnd > el.selectionStart) {
      setSelection({
        start: el.selectionStart,
        end: el.selectionEnd,
        text: el.value.slice(el.selectionStart, el.selectionEnd),
      });
    } else setSelection(null);
  };
  const applyReading = () => {
    try {
      if (!selection) throw new Error("先在正文中选中要标注的字词。");
      if (!reading.trim()) throw new Error("请输入假名读音。");
      updateBlocks(
        annotateBlocks(blocks, selection.start, selection.end, reading),
      );
      setReading("");
      setMessage("已添加注音，可在右侧预览。");
    } catch (e) {
      setMessage(e.message);
    }
  };
  const changeReading = (blockIndex, segmentIndex, text) => {
    const next = structuredClone(blocks);
    next[blockIndex].segments[segmentIndex].reading = text;
    next[blockIndex].segments[segmentIndex].origin =
      text !== null ? "manual" : null;
    updateBlocks(next);
  };
  const rubies = blocks.flatMap((b, bi) =>
    b.segments.flatMap((s, si) =>
      s.reading !== null ? [{ ...s, bi, si, key: `${b.id}:${si}` }] : [],
    ),
  );
  const incompleteRuby = rubies.some((r) => !r.reading.trim());

  return (
    <form
      className="editor-page"
      onSubmit={(e) => {
        e.preventDefault();
        if (!incompleteRuby && !saving)
          onSave({ ...value, content: serializeBlocks(blocks) });
      }}
    >
      <fieldset className="editor-controls" disabled={saving}>
        <div className="editor-heading">
          <div>
            <span className="eyebrow">
              {initial.id ? "校对材料" : "放进书架"}
            </span>
            <h1>{initial.id ? "留住准确的每一行" : "导入一篇新材料"}</h1>
          </div>
          <div className="editor-actions">
            <button
              type="button"
              className="button subtle"
              onClick={onCancel}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={
                saving || !value.title.trim() || !body.trim() || incompleteRuby
              }
            >
              <Icon name="check" size={17} />
              {saving ? "正在保存…" : "保存并阅读"}
            </button>
          </div>
        </div>
        <div className="metadata-form">
          <label className="title-field">
            标题
            <input
              aria-label="材料标题"
              value={value.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="给这篇材料起个名字"
              maxLength={160}
              required
              autoFocus
            />
          </label>
          <label>
            材料类型
            <select
              aria-label="材料类型"
              value={value.kind}
              onChange={(e) => update({ kind: e.target.value })}
            >
              {Object.entries(kinds).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            阅读方向
            <select
              aria-label="阅读方向"
              value={value.orientation}
              onChange={(e) => update({ orientation: e.target.value })}
            >
              <option value="horizontal">横排</option>
              <option value="vertical">竖排</option>
            </select>
          </label>
        </div>
        <div className="editor-workspace">
          <section className="source-panel" aria-label="编辑区域">
            <div className="panel-tabs" role="tablist" aria-label="校对方式">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "text"}
                aria-controls="text-editor-panel"
                id="text-editor-tab"
                onClick={() => setTab("text")}
              >
                正文编辑
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "ruby"}
                aria-controls="ruby-editor-panel"
                id="ruby-editor-tab"
                onClick={() => setTab("ruby")}
              >
                注音校正 <span>{counts.rubyCount}</span>
              </button>
            </div>
            {tab === "text" ? (
              <div
                id="text-editor-panel"
                role="tabpanel"
                aria-labelledby="text-editor-tab"
              >
                <p className="panel-hint">
                  粘贴日语原文，保留段落和歌词分行。选中字词后可添加注音。
                </p>
                <textarea
                  ref={textarea}
                  className="source-textarea"
                  aria-label="日语正文"
                  lang="ja"
                  placeholder={
                    "把想读的日语放在这里。\n\n可以是一段歌词、一篇文章，\n或教材中还没读懂的那一页。"
                  }
                  value={body}
                  onChange={(e) => editBody(e.target.value)}
                  onSelect={getSelection}
                  onBlur={getSelection}
                  onKeyUp={getSelection}
                  onMouseUp={getSelection}
                  maxLength={200000}
                  spellCheck={false}
                />
                <div className="annotation-tools">
                  <div className="selection-label">
                    {selection ? (
                      <>
                        已选中{" "}
                        <strong lang="ja">
                          {selection.text.length > 18
                            ? `${selection.text.slice(0, 18)}…`
                            : selection.text}
                        </strong>
                      </>
                    ) : (
                      <span>在上方选中字词，为它标注读音</span>
                    )}
                  </div>
                  <div className="annotation-input-row">
                    <input
                      ref={readingInput}
                      aria-label="假名读音"
                      lang="ja"
                      value={reading}
                      onChange={(e) => setReading(e.target.value)}
                      placeholder="例如：せなか"
                      maxLength={120}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          applyReading();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      onClick={applyReading}
                      disabled={!selection || !reading.trim()}
                    >
                      添加注音
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="ruby-editor"
                id="ruby-editor-panel"
                role="tabpanel"
                aria-labelledby="ruby-editor-tab"
              >
                <p className="panel-hint">
                  按词组校正读音。送假名留在正文中，例如「生まれた」只给「生」标注「う」。
                </p>
                {incompleteRuby && (
                  <p className="panel-hint">
                    请补齐空白读音，或点击右侧 × 移除注音后再保存。
                  </p>
                )}
                {rubies.length === 0 && (
                  <div className="empty-rubies">
                    <Icon name="type" size={28} />
                    <p>还没有注音</p>
                    <small>回到正文编辑，选中字词后添加。</small>
                  </div>
                )}
                {rubies.map((r) => (
                  <div className="ruby-edit-row" key={r.key}>
                    <label>
                      <span lang="ja">{r.text}</span>
                      <input
                        aria-label={`${r.text}的读音（第${r.bi + 1}行）`}
                        lang="ja"
                        value={r.reading}
                        onChange={(e) =>
                          changeReading(r.bi, r.si, e.target.value)
                        }
                        maxLength={120}
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除${r.text}的注音（第${r.bi + 1}行）`}
                      onClick={() => changeReading(r.bi, r.si, null)}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {message && (
              <div className="editor-message" role="status">
                {message}
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭校对提示"
                  onClick={() => setMessage("")}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
          </section>
          <section className="preview-panel" aria-label="阅读预览">
            <div className="preview-heading">
              <span>阅读预览</span>
              <small>随修改更新</small>
            </div>
            <div className="preview-content">
              {body.trim() ? (
                <RubyText
                  blocks={blocks}
                  fontSize={23}
                  orientation={value.orientation}
                />
              ) : (
                <p className="preview-placeholder" lang="ja">
                  ここから、はじめよう。
                </p>
              )}
            </div>
          </section>
        </div>
        <div className="editor-footnote">
          <span>
            {counts.charCount} 字 · {counts.rubyCount} 处注音
          </span>
          <span>保存后可在书架中重新打开</span>
        </div>
      </fieldset>
    </form>
  );
}
