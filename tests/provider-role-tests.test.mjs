import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenAIModelTests } from "../server/providers/openai/model-tests.mjs";
import { roleReport } from "../shared/ai-roles.mjs";

test("OpenAI按角色手动测试：结构化调用走CLI参数，问答走实际流式通道，适用结果合并并绑定授权", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-role-checks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let credentialId = "grant-one";
  const credentialStatus = async () => ({ credentialId, connected: true, activeAccountId: "account", subject: "subject" });
  const calls = [];
  const runtime = { run: async (input) => {
    calls.push(input);
    if (input.webSearch) {
      await input.onEvent({ type: "delta", delta: "解释" });
      return { text: "解释", completed: true, model: input.model };
    }
    return { text: input.image ? "42" : '{"ok":true}', completed: true, model: input.model };
  } };
  const checks = createOpenAIModelTests({ directory, credentialStatus, runtime });
  assert.deepEqual(await checks.reports(), []);
  assert.equal(calls.length, 0, "查询测试状态不自动推理");
  const annotation = await checks.test("text-model", { role: "annotation" });
  assert.equal(annotation.passed, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].schema);
  assert.equal(calls[0].image, undefined);
  assert.equal(calls[0].webSearch, undefined);
  assert.equal(calls[0].model, "text-model");
  assert.equal(roleReport(await checks.reports(), "text-model", "segmentation").passed, true);
  const chat = await checks.test("chat-model", { role: "chat" });
  assert.equal(chat.passed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].webSearch, true);
  assert.equal(calls[1].schema, undefined);
  assert.equal(calls[1].model, "chat-model");
  assert.equal(calls[1].expectedAccountId, "account");
  const image = await checks.test("vision-model", { role: "ocr" });
  assert.equal(image.passed, true);
  assert.equal(calls.length, 4);
  assert.ok(calls[3].image.startsWith("data:image/png;base64,"));
  const reopened = createOpenAIModelTests({ directory, credentialStatus, runtime });
  assert.equal(roleReport(await reopened.reports(), "vision-model", "annotation", true).passed, true);
  assert.equal((await stat(join(directory, "model-checks.json"))).mode & 0o777, 0o600);
  assert.ok(JSON.parse(await readFile(join(directory, "model-checks.json"), "utf8")).checks.length);
  credentialId = "grant-two";
  assert.deepEqual(await reopened.reports(), [], "同账号换授权也必须重新测试");
});

test("问答测试拒绝仅最终快照或中断输出，失败状态可显示但不会伪造成通过", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-chat-checks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialStatus = async () => ({ credentialId: "grant", connected: true });
  const checks = createOpenAIModelTests({ directory, credentialStatus,
    runtime: { run: async () => ({ text: "只有快照", completed: true }) } });
  const report = await checks.test("chat-model", { role: "chat" });
  assert.equal(report.passed, false);
  assert.equal(report.checks.streaming.state, "failed");
  assert.ok(report.checks.streaming.checkedAt);
});

test("同一OpenAI模型的默认与显式推理强度分别保存测试，不互相覆盖或复用", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-reasoning-checks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialStatus = async () => ({ credentialId: "grant", connected: true, activeAccountId: "account", subject: "subject" });
  const calls = [];
  const checks = createOpenAIModelTests({ directory, credentialStatus, runtime: {
    run: async (input) => { calls.push(input); return { text: '{"ok":true}', completed: true }; },
  } });
  await checks.test("one-model", { role: "segmentation" });
  await checks.test("one-model", { role: "segmentation", reasoning: { effort: "low" } });
  assert.equal(calls[0].reasoning, undefined);
  assert.deepEqual(calls[1].reasoning, { effort: "low" });
  const reports = await checks.reports();
  assert.equal(reports.length, 2);
  assert.equal(roleReport(reports, "one-model", "segmentation").passed, true);
  assert.equal(roleReport(reports, "one-model", "annotation", false, { effort: "low" }).passed, true);
  assert.equal(roleReport(reports, "one-model", "segmentation", false, { effort: "high" }), null);
  const reopened = createOpenAIModelTests({ directory, credentialStatus, runtime: {} });
  assert.equal(roleReport(await reopened.reports(), "one-model", "segmentation", false, { effort: "low" }).passed, true);
});
