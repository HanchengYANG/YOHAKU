import { createApp } from "./app.mjs";

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 需要是有效端口。");
const { app, close } = createApp({ dataDir: process.env.DATA_DIR });
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`余白已启动：http://127.0.0.1:${port}`);
});
server.on("error", (error) => {
  console.error(`启动失败：${error.message}`);
  close();
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    close();
    process.exitCode = 0;
  });
  server.closeIdleConnections();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
