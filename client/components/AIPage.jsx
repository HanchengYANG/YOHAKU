import { useState } from "react";
import AISettings from "./AISettings.jsx";
import RoleSettings from "./RoleSettings.jsx";

// One AI page for the site owner (§5.3): connections and roles as two tabs.
export default function AIPage({ initialTab = "connection", onClose }) {
  const [tab, setTab] = useState(initialTab);
  return <section className="stage2-page ai-page" aria-label="AI">
    <div className="stage2-heading"><h1>AI</h1>
      <button type="button" className="button subtle" onClick={onClose}>返回</button></div>
    <div className="task-tabs" role="tablist" aria-label="AI 分类">
      {[["connection", "连接"], ["roles", "角色"]].map(([value, label]) => <button key={value} type="button" role="tab"
        className="button subtle" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    {tab === "connection" ? <AISettings embedded onClose={onClose} /> : <RoleSettings embedded onClose={onClose} />}
  </section>;
}
