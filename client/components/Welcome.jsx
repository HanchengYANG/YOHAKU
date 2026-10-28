import { parseText } from "../../shared/document.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";

export default function Welcome({ onImport, onSample }) {
  const preview = parseText(
    "はーい{口|くち}{開|あ}けてー\n{汚|きたな}い{言葉|ことば}の{歯石|しせき}が{取|と}れないね〜",
  );
  return (
    <section className="welcome">
      <div className="welcome-kicker">
        <span />
        一方书页，一点余白
      </div>
      <h1>
        从一段想读的
        <br />
        日语开始<span>。</span>
      </h1>
      <p className="welcome-description">
        放进喜欢的歌词、文章或教材，
        <br className="desktop-break" />
        把读音校对好，按自己的节奏慢慢读。
      </p>
      <div className="welcome-actions">
        <button className="button primary large" onClick={onImport}>
          <Icon name="plus" size={18} />
          导入第一篇文字
        </button>
        <button className="text-button" onClick={onSample}>
          试试注音示例
          <Icon name="arrow" size={17} />
        </button>
      </div>
      <div className="example-sheet">
        <div className="sheet-caption">
          <span>ふりがな</span>
          <span>注音排版参考</span>
        </div>
        <RubyText blocks={preview} fontSize={24} />
        <div className="sheet-footnote">
          读音在字词上方，送假名留在原文里。
          <span>
            例：
            <ruby>
              背中<rt>せなか</rt>
            </ruby>
          </span>
        </div>
      </div>
      <div className="welcome-footer">
        <span>01 / 阅读与校对</span>
        <p>
          本阶段支持文字导入与保存。图片识别、AI 旁注和朗读将在后续阶段接入。
        </p>
      </div>
    </section>
  );
}
