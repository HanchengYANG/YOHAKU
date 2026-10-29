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
| `TLS_MODE` | `local-ca` 创建独立 CA 和站点证书；`self-signed` 单张自签；`existing` 仅使用已有文件。未配置时兼容旧实例，使用 `self-signed` |
| `TLS_CA_CERT`、`TLS_CA_KEY` | CA 公开证书及签发私钥路径；`local-ca` 必填且与站点文件分开，CA 私钥仅供部署脚本使用 |
| `TLS_CERT_DAYS`、`TLS_CA_DAYS` | 新站点证书与新 CA 的有效天数，默认 365 / 3650 |
| `DEPLOY_TEST_HTTP_TIMEOUT_MS` | 部署时账号测试请求的等待毫秒数，默认 30000，供较慢服务器配置；不影响应用超时或密码哈希参数 |

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
脚本只根据 `PUBLIC_ORIGIN` / `PUBLIC_ORIGINS` 生成 SAN，不探测或猜测网络地址。按 `TLS_MODE` 在所配置的文件路径创建缺失证书，并校验现有证书的域名、有效期、私钥和证书链。文件不成对、名称不匹配或证书过期时停止，已有证书不会静默替换。
手机 PWA 的安装取决于设备对 HTTPS 证书的信任状态。

仅生成或校验证书，不重启服务：

```bash
sudo bash scripts/pi-certificates.sh deploy/instances/production.env
```

更改来源配置或续期后，显式重新签发站点证书并应用。`local-ca` 保留根证书，手机无需重新安装；`self-signed` 会更换信任证书，需要重新安装。旧站点证书与私钥会备份到原证书目录中的 `backup.*`。

```bash
sudo bash scripts/pi-certificates.sh --renew deploy/instances/production.env
sudo bash scripts/pi-setup-system.sh deploy/instances/production.env
```

`existing` 模式不生成或更新证书，适合使用自己管理的证书；可留空 `TLS_CA_CERT` 关闭根证书下载。`local-ca` 的 CA 私钥必须保留在服务器的私有路径中，运行服务和访问者均不读取它。

从旧的单张自签证书迁移到 `local-ca` 时，将旧证书和私钥路径明确填入 `TLS_CA_CERT` / `TLS_CA_KEY`，为 `TLS_CERT` / `TLS_KEY` 配置另一组新路径。脚本会使用原来的 CA 签发站点证书，保留访问者已有的根证书信任。

### 访问者下载并信任证书

配置了根证书时，部署会将 `TLS_CA_CERT` 导出为 DER 格式，并由 Nginx 在站点的 `/yohaku.crt` 提供下载，无需登录。只公开证书，私钥留在服务器上。若站点证书由独立 CA 签发，`TLS_CERT` 应包含站点证书及证书链，`TLS_CA_CERT` 指向对应的根证书；站点证书的 SAN 需覆盖配置中的内网地址和公网域名。

首次访问时先确认浏览器证书提示并继续，页面安装提示中会提供「下载证书」入口，也可直接打开 `https://<站点地址及端口>/yohaku.crt`。下载地址不会被 Service Worker 替换为离线首页。

- iPhone/iPad：用 Safari 下载，允许安装描述文件；到「设置 → 已下载描述文件」安装，再到「设置 → 通用 → 关于本机 → 证书信任设置」开启该根证书的完全信任。回到 Safari 刷新后再添加到主屏幕。详见 [Apple 的手动信任说明](https://support.apple.com/102390)。
- Android：下载后到系统「安全 → 加密与凭据 → 安装证书 → CA 证书」选择 `yohaku.crt`，再刷新站点。

## 后续部署和配置更新

先把通用代码推送到 GitHub，再在服务器上执行：

```bash
bash scripts/pi-deploy.sh
# 或明确指定一个私有实例：
bash scripts/pi-deploy.sh deploy/instances/production.env
```

脚本要求工作区干净且当前分支与配置一致，使用实例指定的 deploy key 执行 `git pull --ff-only`。
停服前先校验配置并准备证书；停止服务后将完整数据目录备份到应用用户的 `~/.local/state/yohaku/backups/<UTC时间>/data/`，安装依赖、串行测试和构建，再根据同一实例重新渲染系统配置、启动服务并校验证书链、主机名和健康接口。
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
