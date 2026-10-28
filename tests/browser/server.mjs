import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Reset the dedicated test store before SQLite opens it, never the user's data/.
const dataDir = new URL("../../artifacts/e2e-data/", import.meta.url);
await rm(dataDir, { recursive: true, force: true });
process.env.DATA_DIR = fileURLToPath(dataDir);
await import("../../server/index.mjs");
