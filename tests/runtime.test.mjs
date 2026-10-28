import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexRuntime } from "../server/providers/openai/runtime.mjs";

const catalog = [
  {
    id: "fixture-model",
    model: "fixture-model",
    hidden: false,
    isDefault: true,
    inputModalities: ["text", "image"],
  },
];

async function fixture(t, options = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), "yohaku-runtime-"));
  const state = {
    account: {
      connected: true,
      id: "account-one",
      activeAccountId: "account-one",
    },
    token: "test-private-access",
    statusReads: 0,
  };
  const auth = {
    status: async () => {
      state.statusReads++;
      return structuredClone(state.account);
    },
    accessToken: async () => state.token,
    ...options.auth,
  };
  const children = [],
    turns = [],
    requests = [];
  let threadSequence = 0,
    turnSequence = 0;
  const spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.options = spawnOptions;
    child.killed = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.emitMessage = (message) =>
      child.stdout.write(`${JSON.stringify(message)}\n`);
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => {
        child.emit("exit", 0);
        child.stdout.end();
        child.stderr.end();
      });
      return true;
    };
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split("\n")) {
          const request = JSON.parse(line);
          requests.push(request);
          queueMicrotask(() => {
            if (child.killed || !request.method || request.id === undefined)
              return;
            const reply = (result) =>
              child.emitMessage({ id: request.id, result });
            if (options.rejectEnvironments && request.params?.environments) {
              child.emitMessage({
                id: request.id,
                error: { message: "environments is not supported" },
              });
              return;
            }
            if (request.method === "initialize")
              reply({
                userAgent:
                  options.userAgent || "yohaku_reader/0.160.1 (fixture)",
              });
            else if (request.method === "model/list")
              reply(options.catalog || { data: catalog });
            else if (request.method === "thread/start")
              reply({ thread: { id: `thread-${++threadSequence}` } });
            else if (request.method === "thread/resume")
              reply({ thread: { id: request.params.threadId } });
            else if (request.method === "turn/start") {
              const id = `turn-${++turnSequence}`;
              const context = {
                child,
                request,
                id,
                reply: () =>
                  reply({ turn: { id, status: "inProgress", items: [] } }),
                notify: (method, params = {}) =>
                  child.emitMessage({
                    method,
                    params: {
                      threadId: request.params.threadId,
                      turnId: id,
                      ...params,
                    },
                  }),
                complete: (status = "completed", items = [], error = null) =>
                  child.emitMessage({
                    method: "turn/completed",
                    params: {
                      threadId: request.params.threadId,
                      turn: { id, status, items, error },
                    },
                  }),
                item: (
                  text,
                  phase = "final_answer",
                  itemId = `item-${turnSequence}`,
                ) =>
                  child.emitMessage({
                    method: "item/completed",
                    params: {
                      threadId: request.params.threadId,
                      turnId: id,
                      completedAtMs: Date.now(),
                      item: { type: "agentMessage", id: itemId, text, phase },
                    },
                  }),
              };
              turns.push(context);
              if (options.onTurn) options.onTurn(context);
              else context.reply();
            }
          });
        }
        done();
      },
    });
    children.push(child);
    return child;
  };
  const runtime = createCodexRuntime({
    auth,
    storageDir,
    spawnImpl,
    turnTimeoutMs: options.turnTimeoutMs || 5000,
  });
  t.after(async () => {
    runtime.stop();
    await delay(0);
    await rm(storageDir, { recursive: true, force: true });
  });
  return { runtime, children, turns, requests, state, storageDir };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(2);
  }
  throw new Error("Test event not received");
}

test("只有对应 turn 的 completed 终态和最终消息能够返回结果，保留完整长文本", async (t) => {
  const f = await fixture(t);
  let settled = false;
  const job = f.runtime.run({ prompt: "解释日语句子" });
  job
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await waitFor(() => f.turns.length === 1);
  const turn = f.turns[0];
  turn.notify("item/agentMessage/delta", {
    itemId: "partial",
    delta: "尚未完成的部分",
  });
  await delay(5);
  assert.equal(settled, false);
  turn.item("正在分析原文。", "commentary", "commentary");
  const answer = "准确解释。".repeat(400);
  turn.item(answer);
  await delay(5);
  assert.equal(settled, false);
  turn.complete();
  const result = await job;
  assert.equal(result.text, answer);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.completed, true);
  assert.equal(result.model, "fixture-model");
  assert.equal(f.runtime.status().busy, false);
  assert.ok(f.runtime.status().lastSuccessfulAt);
});

test("RPC 答复前到达的终态可以正确处理，但旧 turn 的迟到事件不会结束新 turn", async (t) => {
  const f = await fixture(t, {
    onTurn: (turn) => {
      turn.item("已完成");
      turn.complete();
      turn.reply();
    },
  });
  assert.equal((await f.runtime.run({ prompt: "第一问" })).text, "已完成");
  // Override only this test fixture's automatic completion through a second fixture.
  const g = await fixture(t);
  const one = g.runtime.run({ prompt: "第一问" });
  await waitFor(() => g.turns.length === 1);
  g.turns[0].item("第一轮答案");
  g.turns[0].complete();
  const first = await one;
  const next = g.runtime.run({ prompt: "追问", threadId: first.threadId });
  let settled = false;
  next
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await waitFor(() => g.turns.length === 2);
  g.turns[0].item("旧答案");
  g.turns[0].complete();
  await delay(5);
  assert.equal(settled, false);
  g.turns[1].item("第二轮答案");
  g.turns[1].complete();
  assert.equal((await next).text, "第二轮答案");
});

test("失败、被中断、空终态及只有 delta 的部分文本均拒绝作为最终输出", async (t) => {
  for (const status of ["failed", "interrupted", "completed"])
    await t.test(status, async (t) => {
      const f = await fixture(t);
      const job = f.runtime.run({ prompt: "测试不完整返回" });
      job.catch(() => {});
      await waitFor(() => f.turns.length === 1);
      f.turns[0].notify("item/agentMessage/delta", {
        itemId: "partial",
        delta: "部分输出",
      });
      f.turns[0].complete(status);
      await assert.rejects(job, /未完成|最终内容/);
      assert.equal(f.runtime.status().lastSuccessfulAt, null);
    });
});

test("完整终态快照可替代缺失的 item 事件，并屏蔽凭据", async (t) => {
  const f = await fixture(t);
  const job = f.runtime.run({ prompt: "测试快照" });
  await waitFor(() => f.turns.length === 1);
  f.turns[0].complete("completed", [
    {
      type: "agentMessage",
      id: "snapshot",
      phase: null,
      text: `答案 ${f.state.token} Bearer secret`,
    },
  ]);
  const result = await job;
  assert.equal(result.text.includes(f.state.token), false);
  assert.equal(result.text.includes("Bearer secret"), false);
  assert.match(result.text, /已隐藏/);
});

test("进程退出、stdin 断开和等待超时会拒绝并释放 busy", async (t) => {
  for (const type of ["exit", "stdin", "timeout"])
    await t.test(type, async (t) => {
      const f = await fixture(t, {
        turnTimeoutMs: type === "timeout" ? 20 : 5000,
      });
      const job = f.runtime.run({ prompt: "测试断开" });
      job.catch(() => {});
      await waitFor(() => f.turns.length === 1);
      f.turns[0].notify("item/agentMessage/delta", {
        itemId: "partial",
        delta: "部分输出",
      });
      if (type === "exit") f.children[0].emit("exit", 1);
      if (type === "stdin")
        f.children[0].stdin.emit("error", new Error("EPIPE"));
      await assert.rejects(job, /中断|超时/);
      assert.equal(f.runtime.status().busy, false);
      assert.equal(f.runtime.status().running, false);
    });
});

test("并发请求被 409 拒绝，重启或 token 刷新后按原 threadId 恢复", async (t) => {
  const f = await fixture(t);
  const first = f.runtime.run({ prompt: "第一问" });
  await waitFor(() => f.turns.length === 1);
  await assert.rejects(
    f.runtime.run({ prompt: "并发第二问" }),
    (error) => error.status === 409,
  );
  f.turns[0].item("第一轮");
  f.turns[0].complete();
  const answer = await first;
  f.runtime.stop();
  const second = f.runtime.run({ prompt: "追问", threadId: answer.threadId });
  await waitFor(() => f.turns.length === 2);
  f.turns[1].item("恢复后的第二轮");
  f.turns[1].complete();
  await second;
  assert.equal(f.children.length, 2);
  assert.equal(f.requests.filter((r) => r.method === "thread/start").length, 1);
  assert.equal(
    f.requests.filter((r) => r.method === "thread/resume").length,
    1,
  );
  f.state.token = "new-test-private-access";
  const third = f.runtime.run({
    prompt: "刷新后追问",
    threadId: answer.threadId,
  });
  await waitFor(() => f.turns.length === 3);
  f.turns[2].item("刷新后的第三轮");
  f.turns[2].complete();
  await third;
  assert.equal(f.children.length, 3);
  assert.equal(
    f.requests.filter((r) => r.method === "thread/resume").length,
    2,
  );
  for (const turn of f.turns)
    assert.deepEqual(turn.request.params.environments, []);
});

test("隔离 CODEX_HOME、最小环境和配置禁用工具，不继承收费 API key", async (t) => {
  const f = await fixture(t);
  const outputSchema = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  };
  const job = f.runtime.run({
    prompt: "识别图片",
    image: "data:image/png;base64,AA==",
    schema: outputSchema,
  });
  await waitFor(() => f.turns.length === 1);
  const child = f.children[0];
  const env = child.options.env;
  assert.equal(env.CODEX_HOME, child.options.cwd);
  assert.equal(env.CODEX_HOME.startsWith(f.storageDir), true);
  assert.equal(env.YOHAKU_CHATGPT_ACCESS_TOKEN, f.state.token);
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ACCESS_TOKEN",
    "OPENAI_BASE_URL",
  ])
    assert.equal(Object.hasOwn(env, key), false);
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      "CODEX_HOME",
      "HOME",
      "LANG",
      "PATH",
      "YOHAKU_CHATGPT_ACCESS_TOKEN",
    ].sort(),
  );
  assert.equal(
    child.args.some((arg) => arg.includes(f.state.token)),
    false,
  );
  for (const config of [
    "features.shell_tool=false",
    "features.apps=false",
    "features.plugins=false",
    "features.goals=false",
    "features.multi_agent=false",
    "features.view_image=false",
    'web_search="disabled"',
    'shell_environment_policy.inherit="none"',
    "tools.experimental_request_user_input.enabled=false",
    "tools.update_plan.enabled=false",
  ])
    assert.equal(child.args.includes(config), true, config);
  const turn = f.turns[0].request.params;
  assert.deepEqual(
    f.requests.find((r) => r.method === "initialize").params.capabilities,
    { experimentalApi: true },
  );
  assert.deepEqual(
    f.requests.find((r) => r.method === "thread/start").params.environments,
    [],
  );
  assert.deepEqual(turn.environments, []);
  assert.deepEqual(turn.outputSchema, outputSchema);
  assert.equal(turn.input[1].url, "data:image/png;base64,AA==");
  assert.deepEqual(turn.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.equal(turn.approvalPolicy, "never");
  child.emitMessage({
    id: "approval",
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  await waitFor(() => f.requests.some((r) => r.id === "approval" && r.error));
  f.turns[0].item('{"text":"正文"}');
  f.turns[0].complete();
  await job;
});

test("账户在读取凭据时切换会拒绝；启动期间 stop 不会再创建子进程", async (t) => {
  // A deterministic changing identity fixture keeps the test independent of timing.
  let reads = 0;
  const g = await fixture(t, {
    auth: {
      status: async () => ({
        connected: true,
        id: ++reads === 1 ? "old" : "new",
      }),
    },
  });
  await assert.rejects(
    g.runtime.run({ prompt: "测试切换" }),
    (error) => error.status === 409,
  );
  assert.equal(g.children.length, 0);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const h = await fixture(t, {
    auth: {
      accessToken: async () => {
        await blocked;
        return "test-delayed-token";
      },
    },
  });
  const job = h.runtime.run({ prompt: "启动等待" });
  job.catch(() => {});
  await delay(2);
  h.runtime.stop();
  release();
  await assert.rejects(job, /中断/);
  assert.equal(h.children.length, 0);
});

test("RPC 错误中的当前 token、Bearer 和 JWT 不进入可见错误或状态", async (t) => {
  const f = await fixture(t, {
    onTurn: (turn) =>
      turn.child.emitMessage({
        id: turn.request.id,
        error: {
          message:
            "failed test-private-access Bearer another eyJhbGciOiJI.eyJzdWIiOiJz.InRva2Vu",
        },
      }),
  });
  await assert.rejects(f.runtime.run({ prompt: "测试错误" }), (error) => {
    assert.equal(error.message.includes("test-private-access"), false);
    assert.equal(error.message.includes("Bearer another"), false);
    assert.equal(error.message.includes("eyJhbGci"), false);
    return true;
  });
  assert.equal(
    JSON.stringify(f.runtime.status()).includes("test-private-access"),
    false,
  );
  assert.equal(f.runtime.status().running, false);
});

test("无图片模型时不会发推理请求，未授权时不会启动 CLI", async (t) => {
  const f = await fixture(t, {
    catalog: { data: [{ ...catalog[0], inputModalities: ["text"] }] },
  });
  await assert.rejects(f.runtime.run({ prompt: "不支持图片" }), /没有支持图片/);
  assert.equal(
    f.requests.some((r) => r.method === "turn/start"),
    false,
  );
  const g = await fixture(t, {
    auth: { status: async () => ({ connected: false }) },
  });
  await assert.rejects(
    g.runtime.run({ prompt: "未授权" }),
    (error) => error.status === 401,
  );
  assert.equal(g.children.length, 0);
});

test("非已验证的 CLI 版本或不支持 environments 的接口安全失败，不回退默认环境", async (t) => {
  const f = await fixture(t, { userAgent: "yohaku_reader/0.159.0 (fixture)" });
  await assert.rejects(f.runtime.run({ prompt: "版本不匹配" }), /接口兼容性/);
  assert.equal(
    f.requests.some(
      (r) => r.method === "thread/start" || r.method === "turn/start",
    ),
    false,
  );
  const g = await fixture(t, { rejectEnvironments: true });
  await assert.rejects(
    g.runtime.run({ prompt: "不支持环境字段" }),
    /environments/,
  );
  const starts = g.requests.filter((r) => r.method === "thread/start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].params.environments, []);
  assert.equal(
    g.requests.some((r) => r.method === "turn/start"),
    false,
  );
});
