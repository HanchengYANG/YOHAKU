import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["--watch", "server/index.mjs"], {
  stdio: "inherit",
});
const client = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  client.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of [server, client]) {
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
