# 自部署

不用 Cloudflare，把服务端跑在自己的机器上。返回 [README](../README.zh-CN.md)。

## 自部署（备选）

这个项目推荐用 Cloudflare 运行服务端。它很小，免费额度就够用，不用管服务器、TLS 证书和备份任务。想把所有东西放在自己机器上的话，可以自部署：同一份 `worker/*.js` 跑在 Node 22+ 上，数据存在一个 SQLite 文件里，合并和并发规则只有一份实现。

前置条件：一台装了 Docker（或 Node 22+）的主机，以及一个带有效 TLS 证书的**公网域名**。Cloud session 从 Anthropic 的基础设施经由 egress proxy 访问你的服务，所以 `localhost`、内网地址和纯 HTTP 都不行。

### 1. 生成 token 和哈希

服务端只保存哈希。需要两个不同的 token：sync token（作为 network secret 配进 cloud 环境）和 admin token（在管理后台登录页输入）。

```bash
SYNC_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
ADMIN_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
echo "sync token:  $SYNC_TOKEN"     # 两个都现在存好，哈希无法还原成 token
echo "admin token: $ADMIN_TOKEN"
cat > selfhost/.env <<EOF
TOKEN_SHA256=$(printf %s "$SYNC_TOKEN" | sha256sum | cut -d' ' -f1)
ADMIN_TOKEN_SHA256=$(printf %s "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)
ADMIN_SESSION_SECRET=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
PUBLIC_URL=https://memory.example.com
EOF
```

macOS 上把 `sha256sum` 换成 `shasum -a 256`。`selfhost/.env` 已被 gitignore，`selfhost/env.example` 列出了所有配置项。

### 2. 启动

```bash
docker compose -f selfhost/docker-compose.yml --env-file selfhost/.env up -d --build
curl -sS http://127.0.0.1:8787/health      # {"ok":true}
```

容器以非 root 用户运行，SQLite 数据库放在 `memory-data` volume 里（`/data/memory.db`）。不用 Docker 的话：`TOKEN_SHA256=<哈希> npm run selfhost`（Node 22+，不需要 `npm install`，数据写到 `./data/memory.db`）。

### 3. 放到公网域名的 HTTPS 后面

把域名（如 `memory.example.com`）的 DNS 指向这台主机，用任意反向代理终结 TLS。compose 文件里有一段注释掉的 Caddy 服务，会自动申请证书：取消注释，在 compose 文件旁创建 `Caddyfile`，内容为

```
memory.example.com {
  reverse_proxy memory:8787
}
```

再删掉 `memory` 服务的 `ports` 映射，只让 Caddy 能访问它。把 `PUBLIC_URL` 设成公网 origin（`https://memory.example.com`）：管理后台会拿写请求的 `Origin` 和服务端看到的 URL 对比，放在 TLS 代理后面时，只有设了 `PUBLIC_URL` 才会对上。

### 4. 配置 Claude cloud 环境

和[快速开始的第 3 步](../README.zh-CN.md#快速开始cloudflare)相同，换成你的域名：

1. **Network secret**：主机填 `memory.example.com`，类型 Bearer，值填 sync token。确认该环境的网络访问策略允许这个主机。
2. **Setup script**：用你的 URL 渲染后粘贴到环境里。

```bash
selfhost/render-setup-script.sh https://memory.example.com > setup-script.rendered.sh
cat setup-script.rendered.sh
```

用 `sed "s|__MEMSYNC_URL__|https://memory.example.com|g" setup-script.template.sh` 效果一样。然后按[快速开始](../README.zh-CN.md#快速开始cloudflare)的最后一步验证。

### 5. 管理后台登录

在 `selfhost/.env` 里前两行只设一个。都不设时，`/admin` 和 Cloudflare 上一样返回 403。

| 配置 | 行为 |
|---|---|
| `ADMIN_TOKEN_SHA256` | `/admin` 显示登录表单。提交的 token 先做哈希，再与这个值做常量时间比较。成功后下发 session cookie：`HttpOnly`、`Secure`、`SameSite=Strict`、路径 `/admin`、有效期 12 小时、带 HMAC 签名。登出会作废该 session。一分钟内失败 10 次后，到这一分钟结束前登录一律拒绝。设置 `ADMIN_SESSION_SECRET` 后，重启不会让登录失效。在 `http://localhost` 上测试时设 `ADMIN_COOKIE_SECURE=0` |
| `ADMIN_TRUST_PROXY_HEADER=<名称>` | 信任反向代理设置的身份 header，代理自己负责认证用户（例如 oauth2-proxy、Authelia 的 `X-Forwarded-User`）。只要 header 非空就放行。仅在代理会清除客户端自带的这个 header、且容器只能经代理访问时使用，否则任何人都能自己发这个 header |
| `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` | 和 Cloudflare 上一样校验 Access JWT（服务端需要能访问你的团队域名） |

同时设了多个模式，或者 `ADMIN_TOKEN_SHA256` 与 `TOKEN_SHA256` 相同，服务端会拒绝启动。

### 6. 备份和更新

全部状态（包括历史）都在一个 SQLite 文件里。服务运行时用 SQLite 的 backup API 做一致性快照：

```bash
# 在主机上，已安装 sqlite3 时（路径取决于 volume 所在位置）
sqlite3 /path/to/memory.db ".backup backup.db"

# 在容器里（不需要 sqlite3）
docker compose -f selfhost/docker-compose.yml exec memory node --disable-warning=ExperimentalWarning -e \
  "const {DatabaseSync,backup}=require('node:sqlite');backup(new DatabaseSync('/data/memory.db'),'/data/backup.db')"
docker compose -f selfhost/docker-compose.yml cp memory:/data/backup.db ./backup.db
```

直接 `cp` `memory.db` 可能漏掉还在 `-wal` 文件里的最新写入。恢复时先停服务，替换 `memory.db`，并删除旁边的 `memory.db-wal` 和 `memory.db-shm`。

更新时 `git pull`，再执行一次 `up -d --build`，启动时会幂等地应用 schema。服务端更新不需要改 setup script，客户端更新需要，见[更新客户端](operations.zh-CN.md#更新客户端)。

配置项：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `TOKEN_SHA256` | 必填 | sync token 的 SHA-256 十六进制 |
| `PORT`、`HOST` | `8787`、`0.0.0.0` | 监听端口和地址 |
| `DB_PATH` | `./data/memory.db`（镜像里是 `/data/memory.db`） | SQLite 文件 |
| `PUBLIC_URL` | 空 | 公网 origin，管理后台放在 TLS 代理后面时需要 |
| `ADMIN_TOKEN_SHA256`、`ADMIN_TRUST_PROXY_HEADER` | 空 | 管理后台认证模式，见上 |
| `ADMIN_SESSION_SECRET` | 每次启动随机生成 | session cookie 的签名密钥 |
| `ADMIN_COOKIE_SECURE` | `1` | 设为 `0` 去掉 `Secure` 标志（只用于 localhost 的 HTTP 测试） |
| `MAX_BODY_BYTES` | `104857600` | 请求体大小上限 |
