import { useEffect, useState } from "react";

const defaultSteps = [
  { id: "upload", label: "上传图片", copy: "正在发送原图，上传完成后会自动识别正文。" },
  { id: "recognize", label: "识别正文", copy: "正在等待正文识别结果，完成后会自动开始注音。" },
  { id: "annotate", label: "生成注音", copy: "正文已保留，正在等待注音结果，完成后打开校对草稿。" },
];

export default function ImportProgress({
  phase,
  startedAt,
  completedSteps = [],
  uploadPercent = null,
  failed = false,
  steps = defaultSteps,
  label = "图片处理进度",
}) {
  const [now, setNow] = useState(() => performance.now());
  const [phaseStartedAt, setPhaseStartedAt] = useState(() => performance.now());
  useEffect(() => {
    setPhaseStartedAt(performance.now());
  }, [phase, startedAt]);
  useEffect(() => {
    setNow(performance.now());
    if (failed) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [failed, startedAt]);

  const currentIndex = steps.findIndex((step) => step.id === phase);
  if (currentIndex < 0) return null;
  const current = steps[currentIndex];
  const percentage = phase === "upload" && Number.isFinite(uploadPercent)
    ? Math.max(0, Math.min(100, Math.floor(uploadPercent))) : null;
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const phaseElapsedMs = Math.max(0, now - phaseStartedAt);
  const waitingForModel = phase === "recognize" || phase === "annotate";
  let copy = current.copy;
  if (failed) copy = "本步尚未完成。已完成的步骤保留，重试会从这里继续。";
  else if (phase === "upload" && percentage === 100)
    copy = "图片数据已发送，正在等待本机服务确认。";
  else if (waitingForModel && phaseElapsedMs >= 30000)
    copy = "仍在等待模型结果，目前无法获知完成比例。返回结果后会自动继续。";
  else if (waitingForModel && phaseElapsedMs >= 15000)
    copy = "仍在等待模型结果，请保持当前页面。";

  return (
    <section className={`import-progress ${failed ? "is-failed" : ""}`}
      aria-label={label} data-phase={phase} data-failed={failed}>
      <div className="import-progress-heading">
        <div>
          <span className="import-progress-eyebrow">当前第{currentIndex + 1}步，共{steps.length}步</span>
          <strong>{failed ? `${current.label}未完成` : `正在${current.label}`}</strong>
        </div>
        <span className="import-progress-time" data-elapsed-ms={Math.round(elapsedMs)} aria-live="off">
          已用时 {Math.floor(elapsedMs / 1000)} 秒
        </span>
      </div>
      <div className="import-progress-track" role="progressbar"
        aria-label={`${current.label}进度`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percentage ?? undefined}
        aria-valuetext={failed ? "本步未完成，可重试" : percentage !== null
          ? `已发送 ${percentage}%` : phase === "upload"
            ? "图片正在上传，发送比例未知" : phase === "rotate"
              ? "正在保存图片方向，完成比例未知" : "正在等待模型结果，完成比例未知"}>
        {steps.map((step) => {
          const complete = completedSteps.includes(step.id);
          const active = step.id === phase;
          return (
            <span className={`import-progress-segment ${complete ? "is-complete" : active ? "is-current" : ""}
              ${active && percentage === null && !failed ? "is-indeterminate" : ""}`}
              key={step.id}>
              <span className="import-progress-fill"
                style={active && percentage !== null ? { width: `${percentage}%` } : undefined} />
            </span>
          );
        })}
      </div>
      <ol className="import-progress-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((step, index) => {
          const complete = completedSteps.includes(step.id);
          const active = step.id === phase;
          const state = complete ? "complete" : active ? failed ? "failed" : "current" : "pending";
          return (
            <li key={step.id} data-step={step.id} data-state={state} aria-current={active ? "step" : undefined}>
              <span className="import-progress-step-number" aria-hidden="true">{complete ? "✓" : index + 1}</span>
              <span><strong>{step.label}</strong><small>{complete ? "已完成" : active ? failed ? "未完成" : "处理中" : "等待"}</small></span>
            </li>
          );
        })}
      </ol>
      {phase === "upload" && percentage !== null && (
        <p className="import-progress-bytes">上传进度 {percentage}%<span> · 按实际发送数据计算</span></p>
      )}
      <p className="import-progress-copy" role="status" aria-live="polite">{copy}</p>
    </section>
  );
}
