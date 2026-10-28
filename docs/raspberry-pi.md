# 配置驱动的 Linux HTTPS 部署

适用于使用 systemd 和 apt 的 ARM64 / x86-64 Linux。仓库只保存通用脚本和模板。
实际用户名、SSH key 路径、域名、IP、端口组合和安装目录写入服务器上的私有实例，不提交到 Git。

## 模板与本地实例

- `deploy/config.env.example`：可提交的配置示例，所有机器共用同一种格式。
- `deploy/instances/`：私有实例目录，整个目录被 Git 忽略。
- `.env.deploy`：默认实例的本地符号链接，也被 Git 忽略。
- `deploy/nginx.conf`、`deploy/yohaku.service`、`deploy/runtime.env`：可提交的渲染模板，只包含占位符。

在克隆好的服务器项目目录中创建实例：

```bash
mkdir -p -m 700 deploy/instances
cp deploy/config.env.example deploy/instances/production.env
chmod 600 deploy/instances/production.env
# 编辑实例，填写当前服务器的实际值。
# 若已有 .env.deploy，请先备份；不要覆盖已有文件。
ln -s deploy/instances/production.env .env.deploy
```

实例使用可信的 shell 变量赋值格式，不应添加命令。使用绝对路径，不使用空格、`~` 或变量替换。
示例模板本身不能用作运行配置；脚本拒绝读取已经被 Git 跟踪的配置文件。

| 配置项 | 用途 |
| --- | --- |
| `APP_USER`、`APP_DIR` | 运行服务的普通 Linux 用户、项目绝对目录 |
| `GIT_REMOTE`、`GIT_BRANCH` | 更新使用的已有 Git remote 和分支，默认 origin / main |
| `DEPLOY_KEY` | 可选的 SSH 私钥绝对路径；为空时保留仓库已有的 SSH 配置 |
| `PUBLIC_ORIGIN` | 浏览器使用的主要 HTTPS 来源，包括外部端口，不含路径和末尾斜线 |
| `PUBLIC_ORIGINS` | 逗号分隔的附加 HTTPS 来源，可同时保留局域网和外网入口 |
| `PORT`、`HTTPS_PORT` | Node 的本机端口、Nginx 的服务器 HTTPS 监听端口，默认 4317 / 443 |
| `DATA_DIR` | 数据目录，为空时使用 APP_DIR/data；脚本不会自动迁移数据 |
| `TLS_CERT`、`TLS_KEY` | 服务器证书、私钥文件路径，已有文件会保留 |

站点来源支持 DNS 名称和 IPv4 地址，外部端口可与服务器监听端口不同。
Node 始终仅监听本机，Nginx 保留外部请求 Host 中的端口。未配置的 Host 和提交来源仍会被拒绝。
脚本不会修改路由器、DNS 或 IPv6 配置；这些需要由对应网络的管理员处理。

## 首次安装

在服务器生成专用 SSH deploy key，把公钥添加到 GitHub 仓库，日常更新只需读取权限。
先核对 GitHub 的 SSH host key 并保存到 known_hosts，不能关闭主机身份校验。
克隆项目时使用该 key；配置中的 `GIT_REMOTE` 和 `GIT_BRANCH` 应与已有 checkout 一致。

默认读取 `.env.deploy` 选中的实例：

```bash
bash scripts/pi-install-runtime.sh
sudo bash scripts/pi-setup-system.sh
```

也可给每个脚本传入明确的实例路径：

```bash
bash scripts/pi-install-runtime.sh deploy/instances/production.env
sudo bash scripts/pi-setup-system.sh deploy/instances/production.env
```

运行环境脚本以 `APP_USER` 执行，从 `.nvmrc` 获取 Node 版本，下载对应架构的官方发行包并核对 SHA256，安装项目要求的 Codex CLI，再安装依赖和构建前端。
Node 和 Codex 安装到应用用户的 `~/.local/share/yohaku/`。

系统配置脚本根据同一实例渲染：

- `/etc/nginx/sites-available/yohaku`：监听端口、全部站点名称、证书和本机反向代理。
- `/etc/systemd/system/yohaku.service`：应用用户、工作目录和运行环境路径。
- `/etc/yohaku/runtime.env`：实际应用端口、数据目录和允许来源，仅 root 可读，由 systemd 注入服务。

渲染结果始终在 Git 目录之外。应用只收到运行所需的变量，不会读取整个部署实例或 SSH 配置。
如果两个证书文件都不存在，脚本会生成覆盖已配置主机名的 365 天自签名证书。已有证书不自动替换；变更域名后需另行更新证书。
手机 PWA 的安装取决于设备对 HTTPS 证书的信任状态。

## 后续部署和配置更新

先把通用代码推送到 GitHub，再在服务器上执行：

```bash
bash scripts/pi-deploy.sh
# 或明确指定一个私有实例：
bash scripts/pi-deploy.sh deploy/instances/production.env
```

脚本要求工作区干净且当前分支与配置一致，使用实例指定的 deploy key 执行 `git pull --ff-only`。
停止服务后将完整数据目录备份到应用用户的 `~/.local/state/yohaku/backups/<UTC时间>/data/`，安装依赖、串行测试和构建，再根据同一实例重新渲染系统配置、启动服务并检查健康接口。
部署期间会短暂中断服务；失败会停止并提示，不自动回滚。备份含私人资料与授权，按需安全保留和清理。

只修改实例配置而不更新代码时，重新运行：

```bash
sudo bash scripts/pi-setup-system.sh
```

更换 `.nvmrc` 中的运行环境版本时，先重新执行运行环境安装脚本。更换数据目录或用户前，需自行完成数据迁移和权限安排。

## AI 首次授权

AI 由首个网站账号（网站拥有者）统一连接，所有已登录账号共享这份授权；其他账号没有 AI 配置权限。
ChatGPT 授权使用本机回调。在执行授权的电脑上，通过自己的 SSH 别名建立隧道，端口需与实例中的 `PORT` 一致。默认端口示例：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 4317:127.0.0.1:4317 YOUR_SSH_ALIAS
```

电脑上的对应端口需空闲。拥有者从服务器 HTTPS 网站进入「AI 设置」并完成授权，再回到 HTTPS 网站刷新状态。
后续 AI 使用无需隧道，重新授权时才需要；书架、图片和讨论仍按网站账号隔离。

## 运维

```bash
sudo systemctl status yohaku nginx
sudo journalctl -u yohaku -n 100 --no-pager
sudo systemctl restart yohaku
systemctl is-enabled yohaku nginx
```

恢复备份前先停止服务，同时恢复当时的应用版本和完整数据目录。
