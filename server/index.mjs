import { createApp } from "./app.mjs";

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 需要是有效端口。");
const { app, close, shutdown } = createApp({ dataDir: process.env.DATA_DIR });
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
  const httpClosed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  void shutdown({ beforeClose:httpClosed }).then(() => {
    process.exitCode = 0;
  }).catch((error) => {
    console.error("停止服务失败：", error.message);
    close();
    process.exitCode = 1;
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
