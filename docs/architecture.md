# 账号与 AI provider 边界

更新日期：2026-10-28。

## 两种账号分开

网站账号负责登录、资料和权限；AI provider 连接负责该用户的模型授权。网站登录成功不代表 AI 已授权，未授权时不会寻找管理员或其他用户的连接作为后备。

| 层 | 可信身份与职责 |
| --- | --- |
| 网站会话 | HttpOnly Cookie 对应服务端会话哈希，得到 `req.user.id` |
| 用户资料 | 所有文章、搜索、导出、原图、识别草稿和聊天按这个 user ID 查询 |
| Provider 选择 | 按站内 user ID 读取当前 provider；客户端传来的 userId/ownerId 不作为归属依据 |
| Provider 连接 | 每个 `(userId, providerId)` 有独立认证管理器、运行时和存储目录 |
| 外部身份绑定 | `(providerId, subject)` 唯一绑定网站用户；同一 OpenAI 身份不能被两个网站用户同时借用 |

管理员可以生成单次、有限期的邀请码。朋友注册后有自己的书架、会话和 provider 目录；管理员身份不会让 AI 请求绕过资料归属检查。

## 代码结构

```text
server/accounts.mjs                 网站账号、会话、邀请
server/providers/index.mjs         提供方注册与构造入口
server/providers/openai/index.mjs  OpenAI connection adapter
server/providers/openai/auth.mjs   本应用的 SIWC OAuth 与刷新
server/providers/openai/runtime.mjs Codex stdio、会话恢复、最终结果校验
server/ai/routes.mjs               图片与讨论业务，选择当前用户的 provider
server/ai/images.mjs               受限图片解码及原图持久存储
shared/ocr.mjs                    业务 OCR Schema、识别提示、验证
```

应用只通过 connection 的 `auth`、`runtime.run`、`runtime.status` 和 `close` 接口使用提供方。OCR 的正文／注音结构和阅读界面不依赖某个厂商的 RPC 协议。OpenAI 的 OAuth、Codex 协议及模型目录处理留在其 adapter 内。

注册表目前只有 OpenAI 启用，认证方式是 `chatgpt_subscription`。`claude` 和 `api_base` 只保留不可用的注册项与空认证方式，界面禁用，调用返回 501；没有客户端、密钥输入、外部请求或计费接入。

## 存储归属

- 数据库：`data/yohaku.sqlite`，每条资料有 owner/user ID。
- 原图：`data/images/`，由 `image_owners` 索引检查所有权，不直接公开整个目录。
- AI 授权：`data/users/<userId>/providers/openai/`。
- Codex 历史：上述提供方目录下的 `runtime/`，再按外部账号区分。
- 所有真实学习数据、授权和备份都被 Git 忽略。

初次创建站内账号时，旧本机资料归初始管理员。这与管理员创建处于同一数据库事务，失败会整体回滚。此前在本应用完成的 SIWC 授权留在旧目录，只有初始账号可以明确点击「绑定刚才的 ChatGPT 授权」认领；认领保留原注册、主机 ID 和历史，并形成持久外部身份绑定，不默认共享给朋友。

## OAuth 回调归属

发起授权时保存一次性 state 对应的网站 user ID 和 provider ID。来自 OpenAI 的跨站回调可能不带 SameSite=Strict 网站 Cookie，因此回调按服务端 state 找回原连接，再由认证模块校验 state、nonce、签名、audience、时效及 granted scopes。不会拿当前浏览器碰巧登录的另一个网站账号接收授权。

运行时当前固定验证 Codex CLI `0.160.1`，使用官方实验字段 `environments: []` 禁止模型访问执行环境。线程创建和每一轮都显式指定；不支持时失败，不回退到默认环境。模型推理、结构化识别及持续运行仍须使用真实账号另行验证。
