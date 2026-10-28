import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDERS,
  createProviderConnection,
} from "../server/providers/index.mjs";

const callbackUri = "http://127.0.0.1:4317/auth/callback";

async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "yohaku-providers-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("提供方注册表仅OpenAI启用，Claude和API Base是无认证的空预留", () => {
  assert.deepEqual(PROVIDERS, [
    {
      id: "openai",
      name: "OpenAI",
      enabled: true,
      authModes: ["chatgpt_subscription"],
    },
    { id: "claude", name: "Claude", enabled: false, authModes: [] },
    { id: "api_base", name: "API Base", enabled: false, authModes: [] },
  ]);
  assert.doesNotMatch(
    JSON.stringify(PROVIDERS),
    /access_token|refresh_token|apiKey|secret|Bearer/,
  );
});

test("未实现提供方明确501且不联网、不创建目录或初始化任何客户端", async (t) => {
  const root = await temporaryDirectory(t);
  const storageDir = join(root, "must-not-exist");
  let fetches = 0,
    spawns = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("测试禁止网络");
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  for (const providerId of ["claude", "api_base", "unknown", "OpenAI", null]) {
    assert.throws(
      () =>
        createProviderConnection({
          providerId,
          storageDir,
          callbackUri,
          openAIOptions: {
            authOptions: { fetchImpl: globalThis.fetch },
            runtimeOptions: {
              spawnImpl: () => {
                spawns++;
                throw new Error("测试禁止启动");
              },
            },
          },
        }),
      (error) =>
        error.status === 501 &&
        error.expose === true &&
        /尚未实现/.test(error.message),
    );
  }
  assert.equal(fetches, 0);
  assert.equal(spawns, 0);
  await assert.rejects(access(storageDir), (error) => error.code === "ENOENT");
  assert.deepEqual(await readdir(root), []);
});

test("默认OpenAI连接未授权时不发推理，能力元信息与账户连接状态分开", async (t) => {
  const storageDir = await temporaryDirectory(t);
  let fetches = 0,
    spawns = 0;
  const connection = createProviderConnection({
    storageDir,
    callbackUri,
    openAIOptions: {
      authOptions: {
        fetchImpl: async () => {
          fetches++;
          throw new Error("测试禁止网络");
        },
      },
      runtimeOptions: {
        spawnImpl: () => {
          spawns++;
          throw new Error("测试禁止启动");
        },
      },
    },
  });
  t.after(() => connection.close());
  assert.equal(connection.id, "openai");
  assert.equal(connection.label, "OpenAI");
  assert.equal(typeof connection.auth.accessToken, "function");
  assert.equal(typeof connection.runtime.run, "function");
  const status = await connection.status();
  assert.equal(status.connected, false);
  assert.equal(status.authentication.requiresLogin, true);
  assert.equal(status.runtime.running, false);
  assert.equal(status.runtime.model, null);
  assert.deepEqual(status.capabilities, {
    imageInput: true,
    structuredOutput: true,
    conversations: true,
    subscriptionAuth: true,
  });
  await assert.rejects(
    connection.runtime.run({ prompt: "测试不应发出的推理" }),
    /订阅授权/,
  );
  assert.equal(fetches, 0);
  assert.equal(spawns, 0);
  assert.doesNotMatch(
    JSON.stringify(status),
    /access_token|refresh_token|id_token|apiKey|Bearer/,
  );
  assert.deepEqual(await readdir(join(storageDir, "openai")), [
    "chatgpt-host.json",
    "runtime",
  ]);
});

test("不同存储目录的OpenAI连接拥有独立主机身份，重开保持各自身份", async (t) => {
  const root = await temporaryDirectory(t);
  const paths = [join(root, "owner-a"), join(root, "owner-b")];
  const first = paths.map((storageDir) =>
    createProviderConnection({ storageDir, callbackUri }),
  );
  t.after(() => first.forEach((connection) => connection.close()));
  const statuses = await Promise.all(
    first.map((connection) => connection.status()),
  );
  assert.ok(statuses.every((status) => !status.connected));
  const hosts = await Promise.all(
    paths.map(async (directory) =>
      JSON.parse(
        await readFile(join(directory, "openai", "chatgpt-host.json"), "utf8"),
      ),
    ),
  );
  assert.notEqual(hosts[0].ext_agent_host_id, hosts[1].ext_agent_host_id);
  assert.ok(hosts.every((host) => /^urn:uuid:/.test(host.ext_agent_host_id)));
  first.forEach((connection) => connection.close());
  const reopened = paths.map((storageDir) =>
    createProviderConnection({ storageDir, callbackUri }),
  );
  t.after(() => reopened.forEach((connection) => connection.close()));
  await Promise.all(reopened.map((connection) => connection.status()));
  const reloadedHosts = await Promise.all(
    paths.map(async (directory) =>
      JSON.parse(
        await readFile(join(directory, "openai", "chatgpt-host.json"), "utf8"),
      ),
    ),
  );
  assert.deepEqual(reloadedHosts, hosts);
});

test("注入选项不能覆盖提供方目录或把另一授权对象注入运行时", async (t) => {
  const root = await temporaryDirectory(t);
  const storageDir = join(root, "selected");
  const unintended = join(root, "wrong-storage");
  let unexpectedAuthCalls = 0,
    spawns = 0;
  const connection = createProviderConnection({
    storageDir,
    callbackUri,
    openAIOptions: {
      storageDir: unintended,
      callbackUri: "https://wrong.example/auth/callback",
      authOptions: {
        storageDir: unintended,
        callbackUri: "https://wrong.example/auth/callback",
      },
      runtimeOptions: {
        storageDir: unintended,
        auth: {
          status: async () => {
            unexpectedAuthCalls++;
            return { connected: true };
          },
        },
        spawnImpl: () => {
          spawns++;
          throw new Error("测试禁止启动");
        },
      },
    },
  });
  t.after(() => connection.close());
  assert.equal((await connection.status()).connected, false);
  await assert.rejects(
    connection.runtime.run({ prompt: "不能使用替换后的授权" }),
    /订阅授权/,
  );
  assert.equal(unexpectedAuthCalls, 0);
  assert.equal(spawns, 0);
  await assert.rejects(access(unintended), (error) => error.code === "ENOENT");
  await access(join(storageDir, "openai", "chatgpt-host.json"));
});
