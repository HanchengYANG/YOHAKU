# 余白 · 日语阅读与笔记

面向个人使用的日语阅读与笔记工具。第一阶段的阅读、保存与振假名校对已验收；第二阶段已实测个人订阅连接、真实模型识别和网页讨论，当前等待图片校对体验的用户验收。

每个网站账号单独绑定自己的 AI 授权；朋友通过邀请码注册。OpenAI 是目前唯一实现的 provider，Claude 和 API Base 保持空预留。边界与目录见 [架构说明](docs/architecture.md)。

## 本机运行

需要 Node.js 24（包含 SQLite）。

```bash
npm ci
npm run dev
```

开发页面：<http://127.0.0.1:5173>。API 默认监听 `127.0.0.1:4317`。

构建后运行：

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。当前绑定本机地址；公网入口和树莓派部署留在后续阶段。

## 文件结构

| 目录 | 用途 |
| --- | --- |
| `client/` | 阅读界面及样式 |
| `server/` | HTTP API 和 SQLite 存储 |
| `server/providers/` | 隔离于业务层的 AI 提供方及其认证／运行时实现 |
| `shared/` | 正文与振假名数据处理 |
| `tests/` | 数据、接口和浏览器验证 |
| `scripts/` | 开发与维护命令 |
| `docs/` | 原始需求、阶段计划和验收说明 |
| `fixtures/images/` | 三张 OCR 测试图及用户提供的振假名参考 |
| `data/` | 本地数据库，自动生成，不进入 Git |
| `artifacts/` | 本机测试产物，不进入 Git |
| `archive/` | 原始交接压缩包，不重复提交 Git |

`docs/requirements.md` 保留原始交接内容，内文中的 `test-images/` 现对应 `fixtures/images/`。

## 当前范围与验证

阶段与验收步骤见 [实施计划](docs/plan.md)。AI、图片 OCR、语音和旁注尚未接入时，不显示为可用能力。不创建或使用按量收费 API key。

```bash
npm run check
npm run test:browser
```

浏览器测试使用独立的 `artifacts/e2e-data/`，不会写入你的 `data/`。默认使用 `/usr/bin/google-chrome`；其他安装路径可用 `CHROME_PATH=/path/to/chrome npm run test:browser` 指定。手机验证使用 Chrome 的触屏及 390px 视口模拟，尚未在真实手机上测试。

第一阶段的操作与验收见 [阶段一验收说明](docs/stage-1.md)。
第二阶段的授权、图片校对与真实推理验证见 [阶段二说明](docs/stage-2.md)。

源代码与测试样本进入 Git，学习数据不进入 Git。
