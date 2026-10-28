import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../server/app.mjs";
import { DatabaseSync } from "node:sqlite";
import { ensureSession, sessionHeaders } from "./helpers/session.mjs";

async function start(dataDir) {
  const { app, close } = createApp({ dataDir });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const running = {
    url: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      const stopped = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await stopped;
      close();
    },
  };
  try {
    await ensureSession(running.url);
  } catch (error) {
    await running.stop();
    throw error;
  }
  return running;
}

async function request(url, path, method = "GET", body, extraHeaders = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...sessionHeaders(url),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}

async function rawGet(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    // Fetch may replace a caller-supplied Host; exercise the actual HTTP header.
    const request = httpRequest(
      `${url}${path}`,
      { headers: { ...sessionHeaders(url), ...headers }, setHost: false },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const sample = {
  title: "阅读测试",
  kind: "lyrics",
  orientation: "horizontal",
  content: "{僕|ぼく}が{生|う}まれた{日|ひ}\n\n{背中|せなか}を撫でる",
};

test("Markdown只在汉字上显示读音，整词正文与结构化读音保存不变", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-ruby-display-"));
  const running = await start(dataDir);
  t.after(async () => {
    await running.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const content = "{お父さん|おとうさん}は{食べる|たべる}。{取り戻す|とりもどす}。{かな|かな}。\n{青サギ|あおサギ}";
  const created = await request(running.url, "/api/documents", "POST", { ...sample, content });
  assert.equal(created.status, 201);
  const exported = await request(running.url, `/api/documents/${created.data.id}/export?format=markdown`);
  assert.ok(exported.data.includes("お<ruby>父<rp>（</rp><rt>とう</rt><rp>）</rp></ruby>さん"));
  assert.ok(exported.data.includes("<ruby>食<rp>（</rp><rt>た</rt><rp>）</rp></ruby>べる"));
  assert.ok(exported.data.includes("<ruby>取<rp>（</rp><rt>と</rt><rp>）</rp></ruby>り<ruby>戻<rp>（</rp><rt>もど</rt><rp>）</rp></ruby>す"));
  assert.ok(!exported.data.includes("<ruby>かな"));
  assert.ok(exported.data.includes("<ruby>青<rp>（</rp><rt>あお</rt><rp>）</rp></ruby>サギ"));
  const reopened = await request(running.url, `/api/documents/${created.data.id}`);
  assert.equal(reopened.data.content, content);
  assert.deepEqual(reopened.data.blocks, created.data.blocks);
});

test("旧竖排资料统一横排输出，受控标题条目保存重开与Markdown导出保持结构", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-layout-"));
  let running = await start(dataDir);
  t.after(async () => {
    await running.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const content = "{登場人物|とうじょうじんぶつ}\n{眞人|まひと}　お母さんを亡くした、11歳の少年。\n「まだ？」……「はい。」";
  const created = await request(running.url, "/api/documents", "POST", {
    ...sample, content, orientation: "vertical",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.orientation, "horizontal");
  const blocks = created.data.blocks;
  ["heading", "list_item", "paragraph"].forEach((type, index) => { blocks[index].type = type; });
  const db = new DatabaseSync(join(dataDir, "yohaku.sqlite"));
  db.prepare("UPDATE documents SET orientation='vertical',blocks_json=? WHERE id=?")
    .run(JSON.stringify(blocks), created.data.id);
  db.close();
  const legacy = await request(running.url, `/api/documents/${created.data.id}`);
  assert.equal(legacy.data.orientation, "horizontal");
  assert.equal(legacy.data.sourceOrientation, "vertical");
  const saved = await request(running.url, `/api/documents/${created.data.id}`, "PUT", {
    ...legacy.data, title: "人物紹介", orientation: "vertical",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.orientation, "horizontal");
  assert.equal(saved.data.content, content);
  assert.deepEqual(saved.data.blocks.map((block) => block.type), ["heading", "list_item", "paragraph"]);
  await running.stop();
  running = await start(dataDir);
  const reopened = await request(running.url, `/api/documents/${created.data.id}`);
  assert.deepEqual(reopened.data, saved.data);
  const markdown = await request(running.url, `/api/documents/${created.data.id}/export?format=markdown`);
  assert.match(markdown.data, /\n## <ruby>登場人物/);
  assert.match(markdown.data, /\n- <ruby>眞人/);
  assert.ok(markdown.data.includes("「まだ？」……「はい。」"));
});

test("材料 API 的真实存储、重开、版本保护和导出", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-api-"));
  let running = await start(dataDir);
  t.after(async () => {
    await running.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  let document;

  await t.test("初次启动没有虚构的材料，健康状态明确未接 AI", async () => {
    const empty = await request(running.url, "/api/documents");
    assert.deepEqual(empty.data, { documents: [] });
    const health = await request(running.url, "/api/health");
    assert.equal(health.data.storage, "sqlite");
    assert.equal(health.data.capabilities.ai, false);
    assert.equal(health.data.capabilities.imageImport, true);
  });

  await t.test("所有请求拒绝外部或无效 Host，本机 Host 仍可访问", async () => {
    for (const host of [
      "attacker.example",
      "127.0.0.1.attacker.example",
      "user@localhost",
      "localhost:99999",
    ]) {
      for (const path of ["/api/documents", "/api/health", "/"]) {
        const status = await rawGet(running.url, path, { Host: host });
        assert.equal(status, 403, `Host ${host} at ${path}`);
      }
    }
    assert.equal(await rawGet(running.url, "/api/documents"), 400);
    for (const host of ["localhost:4317", "127.0.0.1:4317", "[::1]:4317"]) {
      assert.equal(
        await rawGet(running.url, "/api/health", { Host: host }),
        200,
      );
    }
  });

  await t.test(
    "保存文字和振假名，保留歌词空行，客户端伪造 blocks 被忽略",
    async () => {
      const created = await request(running.url, "/api/documents", "POST", {
        ...sample,
        blocks: [{ segments: [{ text: "伪造内容" }] }],
      });
      assert.equal(created.status, 201);
      document = created.data;
      assert.equal(document.content, sample.content);
      assert.equal(document.revision, 1);
      assert.equal(document.blocks.length, 3);
      assert.equal(
        document.blocks[0].segments.find((segment) => segment.text === "生")
          .reading,
        "う",
      );
      const opened = await request(
        running.url,
        `/api/documents/${document.id}`,
      );
      assert.deepEqual(opened.data, document);
      const mode = (await stat(join(dataDir, "yohaku.sqlite"))).mode & 0o777;
      assert.equal(mode, 0o600);
    },
  );

  await t.test("关闭数据库并重启服务后，文字、注音和块 ID 仍一致", async () => {
    await running.stop();
    running = await start(dataDir);
    const reopened = await request(
      running.url,
      `/api/documents/${document.id}`,
    );
    assert.deepEqual(reopened.data, document);
  });

  await t.test("修改元数据并保存，旧页面不能覆盖新版本", async () => {
    const saved = await request(
      running.url,
      `/api/documents/${document.id}`,
      "PUT",
      {
        ...sample,
        title: "校正后的歌词",
        revision: document.revision,
      },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.data.revision, 2);
    assert.equal(saved.data.title, "校正后的歌词");
    assert.deepEqual(
      saved.data.blocks.map((block) => block.id),
      document.blocks.map((block) => block.id),
    );
    const stale = await request(
      running.url,
      `/api/documents/${document.id}`,
      "PUT",
      {
        ...sample,
        title: "旧页面误覆盖",
        revision: document.revision,
      },
    );
    assert.equal(stale.status, 409);
    const latest = await request(running.url, `/api/documents/${document.id}`);
    assert.equal(latest.data.title, "校正后的歌词");
    document = latest.data;
  });

  await t.test("旧页面不能删除新版本，缺少或无效版本也不会删除", async () => {
    for (const body of [
      undefined,
      {},
      { revision: 0 },
      { revision: "2" },
      { revision: 1.5 },
    ]) {
      const invalid = await request(
        running.url,
        `/api/documents/${document.id}`,
        "DELETE",
        body,
      );
      assert.equal(invalid.status, 400);
    }
    const stale = await request(
      running.url,
      `/api/documents/${document.id}`,
      "DELETE",
      { revision: 1 },
    );
    assert.equal(stale.status, 409);
    const latest = await request(running.url, `/api/documents/${document.id}`);
    assert.deepEqual(latest.data, document);
  });

  await t.test(
    "正文长度按纯文字计算，添加注音后仍能保存合法的长文",
    async () => {
      const content = `${"a".repeat(199_999)}{空|そら}`;
      assert.ok(content.length > 200_000);
      const accepted = await request(running.url, "/api/documents", "POST", {
        ...sample,
        content,
      });
      assert.equal(accepted.status, 201);
      assert.equal(accepted.data.content, content);
      await request(
        running.url,
        `/api/documents/${accepted.data.id}`,
        "DELETE",
        { revision: accepted.data.revision },
      );
    },
  );

  await t.test(
    "按正文或标题查找，预览不混入注音；通配符按原样搜索",
    async () => {
      const found = await request(
        running.url,
        `/api/documents?q=${encodeURIComponent("背中")}`,
      );
      assert.equal(found.data.documents.length, 1);
      assert.equal(found.data.documents[0].rubyCount, 4);
      assert.ok(found.data.documents[0].charCount > 0);
      assert.ok(found.data.documents[0].preview.includes("僕が生まれた日"));
      assert.ok(!found.data.documents[0].preview.includes("ぼく"));
      const missing = await request(running.url, "/api/documents?q=%25");
      assert.equal(missing.data.documents.length, 0);
      const titleFound = await request(
        running.url,
        `/api/documents?q=${encodeURIComponent("校正后")}`,
      );
      assert.equal(titleFound.data.documents.length, 1);
    },
  );

  await t.test(
    "导出包含结构化注音及版本，Markdown 使用 ruby 格式",
    async () => {
      const exported = await request(
        running.url,
        `/api/documents/${document.id}/export?format=json`,
      );
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get("content-disposition"), /attachment/);
      assert.equal(exported.data.schemaVersion, 1);
      assert.deepEqual(exported.data.document, document);
      const markdown = await request(
        running.url,
        `/api/documents/${document.id}/export?format=markdown`,
      );
      assert.match(markdown.data, /<ruby>背中<rp>（<\/rp><rt>せなか<\/rt>/);
      assert.ok(!markdown.data.includes("{背中|せなか}"));
      assert.match(markdown.data, /\n\n<ruby>背中/);
    },
  );

  await t.test("跨站提交被拒绝，本机 Vite 页面允许提交", async () => {
    for (const origin of [
      "https://example.com",
      "http://localhost.attacker.test",
      "null",
    ]) {
      const rejected = await request(
        running.url,
        `/api/documents/${document.id}`,
        "DELETE",
        { revision: document.revision },
        { Origin: origin },
      );
      assert.equal(rejected.status, 403);
    }
    const accepted = await request(
      running.url,
      "/api/documents",
      "POST",
      sample,
      { Origin: "http://localhost:5173" },
    );
    assert.equal(accepted.status, 201);
    await request(running.url, `/api/documents/${accepted.data.id}`, "DELETE", {
      revision: accepted.data.revision,
    });
  });

  await t.test("搜索词不能改变 SQL，导出会转义用户输入中的 HTML", async () => {
    const injection = await request(
      running.url,
      `/api/documents?q=${encodeURIComponent("' OR 1=1 --")}`,
    );
    assert.deepEqual(injection.data.documents, []);
    const escaped = await request(running.url, "/api/documents", "POST", {
      ...sample,
      title: "<script>标题</script>",
      content: '<script>alert(1)</script>\n{言葉|ことば}\n{食べる|た"<img>}',
    });
    assert.equal(escaped.status, 201);
    const markdown = await request(
      running.url,
      `/api/documents/${escaped.data.id}/export?format=markdown`,
    );
    assert.ok(!markdown.data.includes("<script>"));
    assert.ok(markdown.data.includes("&lt;script&gt;"));
    assert.ok(markdown.data.includes("  \n<ruby>"));
    assert.ok(!markdown.data.includes("<img>"));
    assert.ok(markdown.data.includes('title="た&quot;&lt;img&gt;">食べる</span>'));
    await request(running.url, `/api/documents/${escaped.data.id}`, "DELETE", {
      revision: escaped.data.revision,
    });
  });

  await t.test(
    "非法输入、缺少版本、不存在的文档和损坏 JSON 返回可显示错误",
    async () => {
      for (const input of [
        null,
        {},
        { ...sample, title: " " },
        { ...sample, title: "a".repeat(161) },
        { ...sample, content: "" },
        { ...sample, content: "a".repeat(200_001) },
        { ...sample, content: "a".repeat(600_001) },
        { ...sample, kind: "unknown" },
        { ...sample, orientation: "sideways" },
      ]) {
        const response = await request(
          running.url,
          "/api/documents",
          "POST",
          input,
        );
        assert.equal(response.status, 400);
        assert.equal(typeof response.data.error, "string");
      }
      const noRevision = await request(
        running.url,
        `/api/documents/${document.id}`,
        "PUT",
        sample,
      );
      assert.equal(noRevision.status, 400);
      const missing = await request(running.url, "/api/documents/not-an-id");
      assert.equal(missing.status, 404);
      const badFormat = await request(
        running.url,
        `/api/documents/${document.id}/export?format=html`,
      );
      assert.equal(badFormat.status, 400);
      const broken = await fetch(`${running.url}/api/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...sessionHeaders(running.url),
        },
        body: "{broken",
      });
      assert.equal(broken.status, 400);
      assert.equal(typeof (await broken.json()).error, "string");
    },
  );

  await t.test("删除后刷新列表和重开均确认不存在", async () => {
    const deleted = await request(
      running.url,
      `/api/documents/${document.id}`,
      "DELETE",
      { revision: document.revision },
    );
    assert.equal(deleted.status, 204);
    assert.deepEqual(
      (await request(running.url, "/api/documents")).data.documents,
      [],
    );
    assert.equal(
      (await request(running.url, `/api/documents/${document.id}`)).status,
      404,
    );
  });
});
