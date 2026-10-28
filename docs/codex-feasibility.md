# Codex 订阅接入：第一阶段调查

检查日期：2026-10-28。此文档记录文档证据和只读检查，不代表运行时 AI 已接通。

## 结论

当前官方提供适用于开源、本地托管应用的 **Sign in with ChatGPT（SIWC）订阅授权**，并给出连接 Codex app-server 的配置。它通过用户为本应用单独批准的 OAuth 授权使用 ChatGPT plan，不要求创建按量计费 API key。可将其作为下一阶段的优先验证路线；账户是否获得授权、模型访问和 OCR 质量仍必须真实测试。[官方概览](https://developers.openai.com/siwc/token-sharing-open-source)、[app-server 接入](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

**不可把“本机 Codex 已登录”视作网站已获授权，也不读取、复制现有 Codex 登录 token。** 新应用应建立自己的 SIWC 注册和受保护凭据存储。官方 app-server 文档允许已有本地／开源应用继续使用其认证，但指出商业或托管服务不允许使用 app-server 旧认证，应转到 SIWC。[认证适用范围](https://learn.chatgpt.com/docs/app-server#auth-endpoints)

## 本机、树莓派和朋友的边界

| 场景 | 当前判断 | 依据与限制 |
| --- | --- | --- |
| 本机、本人私用 | SIWC OSS 路线有明确文档依据，优先验证 | 文档覆盖开源和本地托管应用；首次仍需用户在官方网页注册、授权 |
| 本人管理的树莓派 | 可参考官方 self-hosted VM 流程，但本项目尚未部署或推理验证 | 官方提供本机授权后通过 SSH 转移**本应用的 SIWC 凭据**，树莓派保留自己的稳定 host ID，由树莓派管理后续刷新；这不授权转移已有 Codex 凭据 |
| 通过私人 VPN／网关访问自己的树莓派 | 技术上属于自托管访问的候选架构；不据此宣称任何远程托管产品均获准 | 官方概览区分 local/self-hosted 与 remotely hosted app；边界不够明确时应向官方确认 |
| 朋友使用 | 应按用户隔离数据、聊天和 SIWC 注册；不能默认以主人的订阅凭据代朋友推理 | 注册的 client ID 绑定授权用户和所选 workspace；多人应用需分别处理授权与实际访问条件 |
| 付费或远程托管服务 | 不纳入当前私用实现承诺 | 官方概览要求联系其 interest form，不能从 OSS 方案外推为普遍开放 |

依据：[OSS 适用范围与客户端／主机关系](https://developers.openai.com/siwc/token-sharing-open-source)、[自托管主机](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)、[账户管理](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)。表中关于本项目树莓派和 VPN 的归类属于架构推断，尚非账户可用性实测。

## 本次真实检查

- 本机 `codex --version`：`codex-cli 0.160.1`。
- `codex app-server generate-json-schema` 成功；检查了该版本生成的 `TurnStartParams`、`ThreadStartParams` 和 `ThreadResumeParams`。
- 通过 stdio 启动 app-server，完成 `initialize` → `initialized` → `account/read`（`refreshToken: false`）。
- 返回的安全摘要：`accountType=chatgpt`、`planType=prolite`、`requiresOpenaiAuth=true`。此处保留服务返回的原始套餐标识，不把它推断为某个公开套餐，也不从中推断模型权益。
- 检查过程未发送推理请求、未启动登录、未创建密钥，未读取 `auth.json`、未输出邮箱或凭据，检查子进程已结束。
- Schema 临时生成于 `/tmp/yohaku-codex-feasibility-schema`，没有作为应用源码或用户数据提交。

`account/read` 成功只证明本机 CLI 可读到已有认证元数据，**不能证明 SIWC 授权成功、选定模型可用、图片 OCR 成功或网站 AI 已接通**。

## 能力证据分级

| 能力 | 官方／接口证据 | 本项目实测状态 |
| --- | --- | --- |
| 图片输入 | app-server 支持 `image` 与 `localImage`；SIWC 在模型支持时允许图片输入 | 只查看了原始样本；尚未发 OCR 推理 |
| 结构化 OCR 返回 | 当前 CLI 的 `turn/start` Schema 包含 `outputSchema` | Schema 已检查；模型在 SIWC 路线是否接受并正确返回尚未测 |
| 多轮追问 | `thread/start`、`turn/start` 构成多轮会话接口 | 接口文档已核对；尚未推理验证 |
| 重启后续聊 | 文档提供本地历史与 `thread/resume`，`store:false` 不阻止本地线程持久化 | 尚未验证进程重启和线程恢复 |
| 订阅额度归属 | SIWC 凭据的 granted scopes 决定能否使用 ChatGPT plan；模型列表不等于推理权限 | 仅原有 CLI 认证元数据可读；应用 SIWC 未授权 |
| 持续运行 | 凭据刷新后重启 app-server，再 resume 已保存线程是官方流程 | 尚未实现或进行长期运行测试 |
| 日语朗读 | 本次 SIWC 页面没有证明语音合成受订阅覆盖 | 未接入、未听评，应单独验证免费语音方案 |

依据：[app-server 协议、输入和结构化输出](https://learn.chatgpt.com/docs/app-server)、[SIWC 预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[模型与完成事件](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

## 下一阶段建议的实现与验收

1. 为应用生成并保存稳定 host ID。实现 OAuth state、nonce、PKCE 和 ID token 的签名／issuer／audience／时效校验；仅有有效 ID token 不代表已获订阅使用权。
2. 由用户点击 **Continue with ChatGPT**，在官方页面完成动态客户端注册和授权。首次入口为 `dynamic_agent_client`；保存回调返回的正式 client ID，而非保存该入口 ID。
3. 核实 granted scopes 含 `chatgpt.tokens.use.direct`，将应用自己获取的凭据写入 Git 忽略、权限为 `0600` 的保护目录，日志只记录安全状态。
4. 用该授权配置 app-server stdio；服务端负责刷新和轮换凭据，刷新串行化，token 更新后重启子进程并恢复线程。
5. 查询当前账户可选模型，再做一轮文本推理、同一线程追问、结构化图片识别，最后重启 app-server 后继续问答。只在终态 `turn.status=completed` 时记录成功；模型列表、启动成功或部分流式文本均不算通过。
6. 用三张真实样本分别检查正文／振假名／非正文／手写批注、歌词分行、竖排双页顺序，并记录具体错误，不能把 Schema 合法视作 OCR 质量通过。
7. 验证超时、额度耗尽、授权撤销和进程异常时的可见状态；不自动切换到收费 API。

依据：[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[刷新与凭据安全](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[app-server 配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## 用户需要参与的操作

下一阶段需要本人在官方 ChatGPT 页面进行应用授权，并决定允许本应用使用的订阅用量范围。开发者不能代替本人完成该身份操作。无需向聊天粘贴密码、API key 或 token。若未来开放给朋友，先确认其独立授权体验，不能预设可共享现有订阅。

## 用量和限制

SIWC 的模型访问和完成推理应以授权账户的真实返回为准。请求可能在已经开始流式返回后因订阅额度限制而失败；应等待完成事件并显示实际错误。用量与授权可在 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) 查看管理，不在应用中承诺无限额度，也不自动启用付费后备路径。[完成与额度错误](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[用量管理](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
