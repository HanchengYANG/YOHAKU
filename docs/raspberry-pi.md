# Linux HTTPS 部署

这些脚本适用于使用 systemd 和 apt 的 ARM64 / x86-64 Linux。
所有用户名、服务器地址和安装目录均由部署者提供；仓库只包含通用脚本和模板。
实际 SSH 信息、私钥、证书、授权和本地配置不得提交到 Git。

## 首次安装

1. 在目标服务器以普通应用用户生成专用 SSH deploy key，把公钥添加到 GitHub 仓库，日常更新仅授予读取权限。
2. 核对 GitHub SSH host key 并写入 `~/.ssh/known_hosts`，使用该 key 克隆仓库。通过仓库本地 `core.sshCommand` 指定私钥，保持 `IdentitiesOnly=yes` 和 `StrictHostKeyChecking=yes`。
3. 在项目目录中创建 `.env.deploy`，仅存放本机配置。该文件被 Git 忽略：

```bash
# 示例域名，替换为你的实际 HTTPS 地址。
PUBLIC_ORIGIN=https://reader.example
```

```bash
chmod 600 .env.deploy
bash scripts/pi-install-runtime.sh
source .env.deploy
sudo bash scripts/pi-setup-system.sh "$USER" "$PWD" "$PUBLIC_ORIGIN"
```

安装脚本从 `.nvmrc` 获取 Node 版本，下载对应架构的官方发行包并核对 SHA256，再安装项目要求的 Codex CLI 和构建应用。
Node 和 Codex 安装到应用用户的 `~/.local/share/yohaku/`。
系统配置脚本接收应用用户、绝对项目目录和 HTTPS 来源三个参数，支持不含空格的常规路径，以及 DNS 名称或 IPv4 地址，使用默认 HTTPS 443 端口。
`deploy/` 文件是含占位符的模板，不能直接复制为系统配置。
实际 Nginx 配置和 systemd unit 在服务器 `/etc/` 下生成，不写回 Git。

Nginx 提供 HTTPS 443，Node 仅监听 `127.0.0.1:4317`。
`PUBLIC_ORIGIN` 配置允许的站点 Host 和页面提交来源。
默认生成 365 天自签名证书，浏览器需要确认信任；证书保存在 `/etc/nginx/yohaku/`，私钥仅 root 可读。重复安装保留已有证书；更换主机地址时需另行更新证书。
如启用了防火墙，管理员需根据实际局域网网段允许 TCP 443。脚本不会修改防火墙或路由器。
首次打开网站创建管理员；学习资料和授权位于项目 `data/`，被 Git 忽略。

## 更新部署

在服务器项目目录下，以应用用户执行：

```bash
bash scripts/pi-deploy.sh
```

也可通过自己的 SSH 别名远程执行该命令。实际 SSH 地址和项目路径保留在个人配置中。
脚本要求干净的 main 分支，通过仓库本地配置的 deploy key 执行 `git pull --ff-only origin main`。
停止服务后将完整 `data/` 备份到 `~/.local/state/yohaku/backups/<UTC时间>/data/`，再安装依赖、串行运行测试、构建、启动服务并检查健康接口。
部署会短暂中断服务；失败时停止并提示，不自动回滚。备份包含私人材料和授权，按需安全保留和清理。
修改部署模板后需重新运行系统配置脚本；更换运行环境版本后需重新安装运行环境和系统配置。

## AI 首次授权

目前 ChatGPT 回调固定使用 `http://127.0.0.1:4317/auth/callback`。
在执行授权的电脑上，通过自己的 SSH 别名建立隧道：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 4317:127.0.0.1:4317 YOUR_SSH_ALIAS
```

电脑上的 4317 端口需要空闲。然后从服务器 HTTPS 网站登录首个账号（网站拥有者），在「AI 设置」中连接 ChatGPT。拥有者完成一次授权后，所有已登录账号都可以使用；其他账号没有 AI 配置权限。
回调经隧道返回服务器；完成后重新打开 HTTPS 网站检查连接，再关闭隧道。本机回调页面不携带 HTTPS 网站会话。
后续 AI 使用无需隧道，重新授权时再建立；当前手机不能直接完成该本机回调流程。

## 运维

```bash
sudo systemctl status yohaku nginx
sudo journalctl -u yohaku -n 100 --no-pager
sudo systemctl restart yohaku
systemctl is-enabled yohaku nginx
source .env.deploy
curl -k "$PUBLIC_ORIGIN/api/health"
```

恢复备份前先停止服务，同时恢复当时的应用版本和完整 data 目录。
