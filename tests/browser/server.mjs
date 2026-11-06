import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "../../server/app.mjs";
import { SENTENCE_SCHEMA } from "../../shared/sentences.mjs";
import { ANNOTATION_SCHEMA } from "../../shared/ocr-correction.mjs";
import { HYBRID_ANNOTATION_SCHEMA } from "../../server/ai/hybrid-annotation.mjs";

// Reset the dedicated test store before SQLite opens it, never the user's data/.
const dataDir = new URL("../../artifacts/e2e-data/", import.meta.url);
await rm(dataDir, { recursive: true, force: true });

// Base/PWA tests exercise real accounts, SQLite, HTTP and static assets. The
// mandatory reading gate uses explicit correction/segmentation/annotation doubles;
// no model credentials, external service, OCR or chat requests are involved.
const accountId = "base-segmentation-fixture", subject = "base-segmentation-subject";
const auth = {
  status: async () => ({ connected: true, activeAccountId: accountId, subject }),
  accounts: async () => ({ activeId: accountId, accounts: [{ id: accountId, subject, connected: true }] }),
};
let busy = false;
const runtime = {
  status: () => ({ model: "BASE-SEGMENTATION-TEST-DOUBLE", busy, ready: true, lastError: null }),
  stop: () => { busy = false; },
  run: async ({ schema, prompt }) => {
    busy = true;
    try {
      let value;
      if (schema === SENTENCE_SCHEMA) {
        const text = JSON.parse(prompt.split("\n输入正文：\n").at(-1).split('\n')[0]);
        if (typeof text !== "string") throw new Error("Invalid segmentation fixture input.");
        value = { sentences: text.match(/[^。]*。|[^。]+$/gu) || [text] };
      } else if (schema === HYBRID_ANNOTATION_SCHEMA) {
        // Base reading tests retain the local candidates and manual readings;
        // remote proofreading completes without inventing additional ruby.
        value = { changes: [], uncertain: [] };
      } else if (schema === ANNOTATION_SCHEMA) {
        const targets = JSON.parse(prompt.split('输入目标：\n').at(-1).split('\n')[0]);
        value = { blocks: targets.map(({ text }) => ({ words: [{ t: text, r: null }] })) };
      } else if (schema?.properties?.edits && prompt.includes('目标正文：\n')) {
        const target = JSON.parse(prompt.split('目标正文：\n').at(-1));
        if (typeof target !== "string") throw new Error("Invalid correction fixture input.");
        value = { edits: [] };
      } else throw new Error('Base fixture only supports source text preparation.');
      return { completed: true, text: JSON.stringify(value), model: "BASE-SEGMENTATION-TEST-DOUBLE" };
    } finally { busy = false; }
  },
};
const port = Number(process.env.PORT || 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid browser-fixture port.");
const localRuby = {
  annotate: async () => ({ annotations: [], engine: "BASE-LOCAL-RUBY-TEST-DOUBLE", elapsedMs: 0 }),
  close() {},
};
// Every test case logs in from 127.0.0.1; the production limit (30 per 15 min) would 429 a growing suite.
const { app, close, shutdown } = createApp({ dataDir: fileURLToPath(dataDir), aiServices: { auth, runtime }, localRuby, accountRateLimit: false });
const server = app.listen(port, "127.0.0.1", () => console.log(`基础浏览器测试：http://127.0.0.1:${port}（分句为明确测试替身）`));
server.on("error", (error) => { console.error(error.message); close(); process.exitCode = 1; });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const httpClosed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  void shutdown({ beforeClose: httpClosed }).then(() => { process.exitCode = 0; }).catch((error) => {
    console.error("Stopping browser fixture failed:", error.message); close(); process.exitCode = 1;
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
