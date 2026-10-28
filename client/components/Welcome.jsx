import { parseText } from "../../shared/document.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";

export default function Welcome({ onImport, onSample, onImage }) {
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
        {onImage && (
          <button className="button secondary large" onClick={onImage}>
            <Icon name="book" size={17} />
            导入图片
          </button>
        )}
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
          读音只显示在汉字部分，仍可按完整词校正。
          <span>
            例：
            <ruby>
              背中<rt>せなか</rt>
            </ruby>
          </span>
        </div>
      </div>
      <div className="welcome-footer">
        <span>02 / 图片与讨论</span>
        <p>
          文字可直接导入。连接 ChatGPT
          后可识别图片并讨论原文。自动识别正文并参考原图生成假名，完成后一起校对再保存。旁注和朗读尚未接入。
        </p>
      </div>
    </section>
  );
}
