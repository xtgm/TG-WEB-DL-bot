# TG DualBot Cloudflare

一句话介绍：这是一个支持 Cloudflare Workers 和 Cloudflare Pages Functions 部署的 Telegram 私聊双向机器人后台，提供用户消息转发、管理员回复、Web 管理面板、Telegram 群话题双通道控制、广告拦截、Cloudflare Turnstile 验证门禁以及 IPv4/IPv6/UDP WebRTC 记录。

## 目录

| 内容 | 跳转 |
|---|---|
| 项目定位 | [项目定位](#project-position) |
| 功能总览 | [功能总览](#feature-overview) |
| Web 面板功能 | [Web 面板功能](#web-panel) |
| Telegram 功能 | [Telegram 功能](#telegram-features) |
| Cloudflare 验证门禁 | [Cloudflare 验证门禁](#cloudflare-verification) |
| Telegram 话题双通道 | [Telegram 话题双通道](#topic-mode) |
| 路由表 | [路由表](#routes) |
| 数据表 | [数据表](#database) |
| 完整目录定位 | [完整目录定位](#project-tree) |
| 配置项和密钥 | [配置项和密钥](#config) |
| 新部署准备 | [新部署准备](#requirements) |
| Workers CLI 部署 | [Workers CLI 部署](#workers-cli) |
| Workers 手动复制部署 | [Workers 手动复制部署](#workers-manual) |
| Workers + GitHub 部署 | [Workers + GitHub 部署](#workers-github) |
| Pages + GitHub 部署 | [Pages + GitHub 部署](#pages-github) |
| Pages Direct Upload 部署 | [Pages Direct Upload 部署](#pages-upload) |
| Telegram Webhook 设置 | [Telegram Webhook 设置](#telegram-webhook-setup) |
| 部署后验证 | [部署后验证](#post-deploy-check) |
| 旧库升级 | [旧库升级](#upgrade) |
| 常见问题 | [常见问题](#faq) |
| 安全建议 | [安全建议](#security) |

<a id="project-position"></a>

## 项目定位

本项目把 Telegram Bot 私聊接入 Cloudflare 边缘运行环境，用户给 Bot 发消息后，系统写入 D1 数据库并转发给管理员；管理员可以在 Telegram 内回复，也可以在 Web 后台回复。用户第一次聊天前必须通过 Cloudflare Turnstile 页面，验证成功后才允许消息进入转发流程。

部署目标只有 Cloudflare：

- Workers：`worker.js` 作为主入口。
- Pages Functions：`functions/[[path]].js` 作为 catch-all 入口，并复用 `worker.js` 的业务逻辑。
- 数据库：Cloudflare D1，绑定名必须是 `DB`。
- 验证：Cloudflare Turnstile，服务端调用 `siteverify`。

<a id="feature-overview"></a>

## 功能总览

| 功能 | 说明 |
|---|---|
| Telegram 私聊接入 | 用户私聊 Bot 后自动登记用户资料，记录 username、昵称、语言、消息 ID 和消息类型。 |
| 验证后聊天门禁 | 未通过验证的用户发送 `/start`、`/verify` 或普通消息时，只会收到验证按钮；验证通过前消息不会转发给管理员。 |
| 双向消息转发 | 用户消息写入收件箱并转发给最多 3 个管理员；启用话题模式后也会同步到用户专属 Telegram 话题。 |
| Web 后台回复 | 管理员可在 `/inbox` 页面查看消息、回复用户、重试转发失败的消息；启用话题模式后 Web 回复也可同步到话题。 |
| 用户管理 | `/users` 展示用户资料、验证状态、备注、封禁状态、HTTP IPv4/IPv6、UDP WebRTC IPv4/IPv6、ASN、设备系统。 |
| 广告拦截 | `/rules` 支持维护私聊关键词，命中后可自动封禁并通知管理员。 |
| Cloudflare 验证记录 | `/verifications` 展示 Turnstile 通过记录、HTTP IP、WebRTC UDP 结果、国家、机房、ASN、User-Agent。 |
| Telegram 话题控制 | `CONTROL_MODE=topic/both` 时，验证通过后可自动创建用户专属群话题，管理员在话题里回复会回到用户。 |
| 多管理员 | `ADMIN_CHAT_IDS` 最多取 3 个管理员 ID，可通过后台设置或 Cloudflare 环境变量配置；话题回复也只允许这些 ID。 |
| 后台登录 | `/login` 使用用户名、密码和 Cookie Session；密码、Bot Token 等敏感值通过 Cloudflare Secrets 保存。 |
| 日志与健康检查 | `/logs` 查看运行事件；`/health` 返回 `ok`。 |

<a id="web-panel"></a>

## Web 面板功能

| 页面 | 路径 | 功能 |
|---|---|---|
| 登录 | `/login` | 输入后台用户名和密码，成功后写入 `tg_dualbot_session` Cookie。 |
| 总览 | `/` | 显示用户数、封禁用户、已验证用户、消息记录、CF 验证通过数、公开地址和验证入口格式。 |
| 收件箱 | `/inbox` | 显示用户入站消息、管理员出站回复、消息方向、来源、状态和错误；支持回复与重试。 |
| 用户管理 | `/users` | 查看用户资料、备注、封禁、验证状态、HTTP IP、UDP WebRTC、ASN、设备系统；支持备注、封禁、解封、取消验证。 |
| 广告拦截 | `/rules` | 一行一个关键词；可开关命中后自动封禁。 |
| CF 验证记录 | `/verifications` | 展示每次 Turnstile 通过后的 IP、UDP/WebRTC、ASN、设备系统、User-Agent 和时间。 |
| 设置 | `/settings` | 保存管理员 Chat ID、欢迎语；查看公开地址、验证入口和 Secrets 配置状态。 |
| 日志 | `/logs` | 查看最近事件，例如转发失败、通知失败、Turnstile 校验失败。 |
| 退出 | `/logout` | 清除后台 Cookie。 |

<a id="telegram-features"></a>

## Telegram 功能

| 入口 | 权限 | 作用 |
|---|---|---|
| `/start` | 普通用户 | 登记用户。未验证时返回验证按钮；已验证时返回欢迎语。 |
| `/verify` | 普通用户 | 生成一次性验证链接按钮。 |
| 普通私聊消息 | 普通用户 | 已验证且未封禁时写入收件箱并转发给管理员。 |
| 回复转发消息 | 管理员 | 管理员在 Telegram 内回复 Bot 转发出的消息，系统自动回发给原用户。 |
| `/reply <user_id> <内容>` | 管理员 | 按用户 ID 回复。示例：`/reply 123456789 你好`。 |
| `/block <user_id>` | 管理员 | 封禁用户。 |
| `/unblock <user_id>` | 管理员 | 解封用户。 |
| `/note <user_id> <备注>` | 管理员 | 更新用户备注。 |
| `/who <user_id>` | 管理员 | 查询用户资料、验证状态、IP 和 UDP 信息。 |
| `/spamwords` | 管理员 | 查看广告关键词。 |
| `/spamadd <关键词>` | 管理员 | 添加广告关键词。 |
| `/spamdel <关键词>` | 管理员 | 删除广告关键词。 |
| `/verifylink <user_id>` | 管理员 | 给指定用户生成新的验证链接。 |

验证通过后，管理员会收到 Telegram 通知，通知里包含：

- 用户 ID、昵称、username、语言。
- HTTP IP、HTTP IP 类型、HTTP IPv4、HTTP IPv6。
- WebRTC UDP IPv4、WebRTC UDP IPv6、UDP 状态、Candidate 类型。
- ASN、运营商、国家/地区、Cloudflare 机房。
- 设备系统。
- inline 操作按钮：取消验证、拉黑、获取用户名。

<a id="cloudflare-verification"></a>

## Cloudflare 验证门禁

验证流程：

```text
用户私聊 Bot
  -> Bot 发现用户未验证
  -> 生成 verification_sessions token
  -> Telegram 返回“打开验证页面”按钮
  -> 浏览器打开 /verify/{token}
  -> Cloudflare Turnstile 前端挑战
  -> 浏览器采集 HTTP 探测和 WebRTC UDP 候选信息
  -> POST /verify/{token}
  -> Worker 调用 Turnstile siteverify
  -> 写入 verification_sessions、ip_verifications、users
  -> 用户解除聊天门禁
  -> 管理员收到验证详情通知
```

当前实现记录两类网络信息：

- HTTP 层：从 `CF-Connecting-IP` 读取访问 IP，从 `request.cf` 读取 `country`、`colo`、`asn`、`asOrganization`。
- UDP/WebRTC 层：浏览器尝试通过 STUN 收集 UDP 候选地址，提取公网 IPv4、IPv6、协议和 candidate 类型。

限制说明：

- 单次 HTTP 请求通常只会走 IPv4 或 IPv6 其中一种，因此另一项可能为空。
- WebRTC UDP 记录受浏览器、代理、系统隐私设置、企业网络和运营商网络影响，可能显示 `empty`、`unsupported` 或 `failed`。
- 本项目会记录字段和状态，不把空值伪造成真实 IP。

<a id="topic-mode"></a>

## Telegram 话题双通道

话题模式让同一个项目同时支持 Web 后台和 Telegram 群话题控制。D1 数据库仍是唯一状态源，Web 后台和话题按钮都会修改同一份用户状态。

控制模式：

| 模式 | 说明 |
|---|---|
| `web` | 默认模式，保留 Web 后台和管理员私聊通知，不创建群话题。 |
| `topic` | 用户消息进入 Web 收件箱并转发到群话题，不再私聊通知管理员。 |
| `both` | Web 后台、管理员私聊通知、Telegram 群话题同时启用。 |

需要额外配置：

| 配置 | 示例 | 说明 |
|---|---|---|
| `CONTROL_MODE` | `both` | 启用双通道建议填 `both`。 |
| `TOPIC_GROUP_ID` | `-1001234567890` | 开启 Topics/Forum 的 Telegram 超级群 ID。 |
| `TOPIC_CREATE_POLICY` | `after_verify` | `after_verify` 表示验证通过后创建话题，`first_message` 表示首条消息时创建。 |
| `TOPIC_SYNC_WEB_REPLIES` | `true` | Web 后台和管理员私聊回复是否同步写入用户专属话题。 |

Telegram 群要求：

- 群必须是超级群，并开启 Topics/Forum。
- Bot 必须加入该群并具备创建话题、发送消息权限。
- 话题内回复用户只允许 `ADMIN_CHAT_IDS` 里的 Telegram ID。
- 如果要让 Bot 收到话题里的普通消息，建议在 BotFather 关闭 Privacy Mode。

话题内操作：

```text
/admin
```

按钮包括通过验证、取消验证、拉黑、取消拉黑、获取用户信息、重建话题。Web 后台的用户管理页也提供创建话题、重建话题、取消绑定操作。

<a id="routes"></a>

## 路由表

### 公开路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/health` | GET | 健康检查，返回 `ok`。 |
| `/telegram/webhook` | POST | Telegram Webhook 入口。 |
| `/verify/{token}` | GET | 显示绑定用户的一次性 Cloudflare Turnstile 验证页。 |
| `/verify/{token}` | POST | 提交 Turnstile token 和浏览器网络信息。 |
| `/verify/ip-probe` | GET | 返回当前 HTTP IP、IP 类型、国家、机房、ASN。 |
| `/verify` | GET/POST | 兜底提示页，提醒从 Telegram 验证按钮进入。 |
| `/login` | GET/POST | 后台登录。 |
| `/logout` | GET | 退出后台。 |

### 后台路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/` | GET | 总览。 |
| `/inbox` | GET | 收件箱。 |
| `/inbox/{id}/reply` | GET/POST | 打开回复页并发送回复。 |
| `/inbox/{id}/retry` | POST | 重试转发失败的入站消息。 |
| `/users` | GET | 用户列表。 |
| `/users/{user_id}/note` | POST | 保存备注。 |
| `/users/{user_id}/block` | POST | 封禁用户。 |
| `/users/{user_id}/unblock` | POST | 解封用户。 |
| `/users/{user_id}/unverify` | POST | 取消用户验证状态。 |
| `/rules` | GET/POST | 查看和保存广告关键词。 |
| `/verifications` | GET | CF 验证记录。 |
| `/settings` | GET/POST | 后台设置。 |
| `/logs` | GET | 运行日志。 |

<a id="database"></a>

## 数据表

| 表 | 作用 |
|---|---|
| `users` | Telegram 用户资料、备注、封禁状态、验证状态、最近 HTTP/UDP/IP/ASN/设备信息。 |
| `verification_sessions` | 一次性验证 token、过期时间、验证状态和本次采集到的网络信息。 |
| `ip_verifications` | 每次 Turnstile 通过后的验证记录。 |
| `inbox_messages` | 入站消息、出站回复、消息类型、转发状态、错误信息。 |
| `message_map` | 管理员 Telegram 消息 ID 到用户消息的映射，用于回复定位。 |
| `spam_keywords` | 广告关键词。 |
| `settings` | 管理员 Chat ID、欢迎语等后台设置。 |
| `event_logs` | 运行事件。 |
| `rate_events` | 用户发送频率记录。 |

<a id="project-tree"></a>

## 完整目录定位

```text
tg-dualbot-cloudflare/
├─ .gitignore
│  └─ 忽略 node_modules、.wrangler、.env、.dev.vars 等本地文件。
├─ package.json
│  ├─ npm run dev：本地 wrangler dev。
│  ├─ npm run deploy：Workers 部署。
│  ├─ npm run check：检查 worker.js 和 Pages 入口语法。
│  ├─ npm run db:apply：新部署初始化 D1。
│  ├─ npm run db:upgrade:verification：旧库补验证门禁字段。
│  ├─ npm run db:upgrade:topics：旧库补 Telegram 话题字段。
│  └─ npm run pages:deploy：Pages Direct Upload。
├─ wrangler.toml
│  ├─ name：Worker 名称。
│  ├─ main = "worker.js"：Workers 入口。
│  ├─ [[d1_databases]]：D1 绑定，binding 必须是 DB。
│  └─ [vars]：PUBLIC_BASE_URL、TURNSTILE_SITE_KEY、ADMIN_CHAT_IDS、CONTROL_MODE、TOPIC_GROUP_ID 等普通变量。
├─ worker.js
│  ├─ export default.fetch()：Workers 入口。
│  ├─ handleRequest()：统一路由分发。
│  ├─ layout() 和各页面函数：Web 后台渲染。
│  ├─ telegramWebhook()：Telegram Webhook 校验和分发。
│  ├─ handleCommand()：Telegram 命令。
│  ├─ relayUserMessage()：用户消息入库和转发。
│  ├─ adminReplyByMessage()：管理员回复定位。
│  ├─ verifyPage()/verifySubmit()：Turnstile 验证页和服务端校验。
│  ├─ ensureVerificationSchema()：运行时补齐验证字段。
│  └─ tgCall()、D1 helper、Cookie helper、日志 helper。
├─ functions/
│  └─ [[path]].js
│     └─ Pages Functions catch-all 入口，导入 ../worker.js 并调用 handleRequest()。
├─ public/
│  └─ .keep
│     └─ Pages 静态输出目录占位文件。
├─ migrations/
│  ├─ 0001_initial.sql
│  │  └─ 新部署完整 D1 表结构。
│  └─ 0002_verification_gate.sql
│     └─ 旧数据库升级到验证门禁版本。
└─ README.md
   └─ 功能、部署、配置、验证和排错说明。
```

<a id="config"></a>

## 配置项和密钥

### `wrangler.toml` 普通变量

| 名称 | 示例 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://tg-dualbot-cloudflare.example.workers.dev` | 机器人生成验证链接、设置 Webhook 时使用的公开地址，正式部署必须填写。 |
| `TURNSTILE_SITE_KEY` | `0x4AAAAA_example` | 前端 Turnstile Widget 使用。 |
| `CONTROL_MODE` | `both` | 控制通道：`web`、`topic`、`both`。 |
| `TOPIC_GROUP_ID` | `-1001234567890` | 话题群 ID。 |
| `TOPIC_CREATE_POLICY` | `after_verify` | 话题创建策略。 |
| `TOPIC_SYNC_WEB_REPLIES` | `true` | 是否把 Web 后台和管理员私聊回复同步到用户话题。 |
| `ADMIN_CHAT_IDS` | `123456789,987654321` | 管理员 Chat ID，可后续在后台设置页保存。 |

### Cloudflare Secrets

| 名称 | 说明 |
|---|---|
| `BOT_TOKEN` | Telegram Bot Token。 |
| `PANEL_PASSWORD` | Web 后台登录密码。 |
| `PANEL_SECRET` | Cookie Session 签名密钥，建议使用随机长字符串。 |
| `TELEGRAM_SECRET_TOKEN` | Telegram Webhook 请求头校验密钥。 |
| `TURNSTILE_SECRET_KEY` | Turnstile 服务端 `siteverify` 使用。 |
| `PANEL_USER` | 可选，后台用户名；不设置时默认 `admin`。 |

<a id="requirements"></a>

## 新部署准备

你需要准备：

1. Cloudflare 账号。
2. Node.js 和 npm。
3. Telegram Bot Token。
4. 你的 Telegram 管理员 Chat ID，例如 `123456789`。
5. Cloudflare Turnstile Widget 的 Site Key 和 Secret Key。
6. Cloudflare D1 数据库。
7. 如果使用 GitHub 自动部署，需要把本项目推到 GitHub 仓库。

安装依赖并登录 Cloudflare：

```powershell
cd E:\多功能telegram双向机器人\tg-dualbot-cloudflare
npm install
npx wrangler login
```

创建 D1：

```powershell
npx wrangler d1 create tg-dualbot-db
```

把输出里的 `database_id` 填到 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tg-dualbot-db"
database_id = "这里填 Cloudflare 输出的 database_id"
```

创建 Turnstile：

1. 打开 Cloudflare Dashboard。
2. 进入 `Turnstile`。
3. 创建 Widget。
4. Hostname 填你的 Workers、Pages 或自定义域名。
5. 复制 Site Key 到 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`。
6. Secret Key 后面用 `wrangler secret put TURNSTILE_SECRET_KEY` 写入。

初始化 D1：

```powershell
npm run db:apply
```

语法检查：

```powershell
npm run check
```

<a id="workers-cli"></a>

## Workers CLI 部署

1. 修改 `wrangler.toml`：

```toml
name = "tg-dualbot-cloudflare"
main = "worker.js"
compatibility_date = "2026-07-08"

[[d1_databases]]
binding = "DB"
database_name = "tg-dualbot-db"
database_id = "你的 D1 database_id"

[vars]
PUBLIC_BASE_URL = "https://你的-worker地址"
TURNSTILE_SITE_KEY = "你的 Turnstile Site Key"
ADMIN_CHAT_IDS = "123456789"
CONTROL_MODE = "both"
TOPIC_GROUP_ID = "-1001234567890"
TOPIC_CREATE_POLICY = "after_verify"
TOPIC_SYNC_WEB_REPLIES = "true"
```

2. 写入 Secrets：

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put PANEL_PASSWORD
npx wrangler secret put PANEL_SECRET
npx wrangler secret put TELEGRAM_SECRET_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
```

3. 初始化数据库：

```powershell
npm run db:apply
```

4. 部署：

```powershell
npm run deploy
```

5. 部署完成后，把输出的地址写回 `PUBLIC_BASE_URL`，再部署一次：

```powershell
npm run deploy
```

<a id="workers-manual"></a>

## Workers 手动复制部署

适合不想用 CLI 上传代码的情况。

1. Cloudflare Dashboard 进入 `Workers & Pages`。
2. 创建 Worker。
3. 打开在线编辑器，把 `worker.js` 全部内容复制进去并保存部署。
4. 在 Worker 设置里添加 D1 Binding：
   - Binding name：`DB`
   - Database：选择 `tg-dualbot-db`
5. 在 Worker 设置里添加普通变量：
   - `PUBLIC_BASE_URL`
   - `TURNSTILE_SITE_KEY`
   - `ADMIN_CHAT_IDS`
   - `CONTROL_MODE`
   - `TOPIC_GROUP_ID`
   - `TOPIC_CREATE_POLICY`
   - `TOPIC_SYNC_WEB_REPLIES`
6. 在 Worker 设置里添加 Secret：
   - `BOT_TOKEN`
   - `PANEL_PASSWORD`
   - `PANEL_SECRET`
   - `TELEGRAM_SECRET_TOKEN`
   - `TURNSTILE_SECRET_KEY`
7. 打开 D1 控制台，对 `tg-dualbot-db` 执行 `migrations/0001_initial.sql`。
8. 访问 `/health`，应返回 `ok`。
9. 设置 Telegram Webhook。

<a id="workers-github"></a>

## Workers + GitHub 部署

1. 把项目推送到 GitHub。
2. Cloudflare Dashboard 进入 `Workers & Pages`。
3. 选择从 GitHub 导入仓库，并选择 Workers 项目。
4. Root directory 保持仓库根目录。
5. 如果页面要求填写命令：
   - Install command：`npm install`
   - Deploy command：`npm run deploy`
6. 确认项目使用根目录 `wrangler.toml`。
7. 在 Cloudflare 项目设置中配置 D1 Binding、普通变量和 Secrets；话题模式需要配置 `CONTROL_MODE`、`TOPIC_GROUP_ID`、`TOPIC_CREATE_POLICY`、`TOPIC_SYNC_WEB_REPLIES`。
8. 在 D1 控制台执行 `migrations/0001_initial.sql`。
9. 触发一次部署。
10. 部署地址确定后，更新 `PUBLIC_BASE_URL` 并重新部署。
11. 设置 Telegram Webhook。

<a id="pages-github"></a>

## Pages + GitHub 部署

Pages 模式使用 `functions/[[path]].js`，它会把所有请求交给 `worker.js`。

1. Cloudflare Dashboard 进入 `Workers & Pages`。
2. 创建 Pages 项目并连接 GitHub 仓库。
3. Root directory：仓库根目录。
4. Build command：可留空；如果界面要求命令，可填 `npm install`。
5. Build output directory：`public`。
6. Functions directory：使用仓库里的 `functions`。
7. 部署完成后，在 Pages 项目设置里添加 D1 Binding：
   - Binding name：`DB`
   - Database：`tg-dualbot-db`
8. 添加普通变量：
   - `PUBLIC_BASE_URL`
   - `TURNSTILE_SITE_KEY`
   - `ADMIN_CHAT_IDS`
   - `CONTROL_MODE`
   - `TOPIC_GROUP_ID`
   - `TOPIC_CREATE_POLICY`
   - `TOPIC_SYNC_WEB_REPLIES`
9. 添加 Secrets：
   - `BOT_TOKEN`
   - `PANEL_PASSWORD`
   - `PANEL_SECRET`
   - `TELEGRAM_SECRET_TOKEN`
   - `TURNSTILE_SECRET_KEY`
10. 在 D1 控制台执行 `migrations/0001_initial.sql`。
11. 重新部署 Pages。
12. 设置 Telegram Webhook。

<a id="pages-upload"></a>

## Pages Direct Upload 部署

本方式使用 Wrangler 上传 `public` 静态目录，同时带上 `functions` 目录中的 Pages Functions。

```powershell
npm run pages:deploy
```

部署后仍要在 Cloudflare Pages 项目设置里配置：

- D1 Binding：`DB`。
- 普通变量：`PUBLIC_BASE_URL`、`TURNSTILE_SITE_KEY`、`ADMIN_CHAT_IDS`、`CONTROL_MODE`、`TOPIC_GROUP_ID`、`TOPIC_CREATE_POLICY`、`TOPIC_SYNC_WEB_REPLIES`。
- Secrets：`BOT_TOKEN`、`PANEL_PASSWORD`、`PANEL_SECRET`、`TELEGRAM_SECRET_TOKEN`、`TURNSTILE_SECRET_KEY`。

<a id="telegram-webhook-setup"></a>

## Telegram Webhook 设置

把 `<BOT_TOKEN>`、`<PUBLIC_BASE_URL>`、`<TELEGRAM_SECRET_TOKEN>` 换成你的真实值：

```powershell
curl.exe -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" `
  -F "url=<PUBLIC_BASE_URL>/telegram/webhook" `
  -F "secret_token=<TELEGRAM_SECRET_TOKEN>" `
  -F "allowed_updates=[`"message`",`"edited_message`",`"callback_query`"]"
```

检查 Webhook：

```powershell
curl.exe "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

`allowed_updates` 必须包含 `callback_query`，否则管理员通知里的 inline 按钮无法回调。

<a id="post-deploy-check"></a>

## 部署后验证

### 1. 健康检查

```text
https://你的地址/health
```

预期返回：

```text
ok
```

### 2. 后台登录

```text
https://你的地址/login
```

默认用户名是 `admin`，密码是 `PANEL_PASSWORD`。

### 3. 用户验证门禁

1. 用普通 Telegram 用户给 Bot 发送 `/start`。
2. Bot 返回“打开验证页面”按钮。
3. 浏览器打开 `/verify/{token}`。
4. 完成 Turnstile。
5. 页面显示验证成功。
6. 用户回到 Telegram 后可以继续聊天。
7. 管理员收到验证详情通知。
8. 后台 `/users` 和 `/verifications` 出现 HTTP/UDP/IP/ASN 信息。

### 4. 双向回复

1. 已验证用户给 Bot 发消息。
2. 管理员 Telegram 收到转发消息。
3. 管理员直接回复 Bot 转发出来的消息。
4. 用户收到管理员回复。
5. 后台 `/inbox` 出现入站和出站记录。

### 5. Web 后台回复

1. 打开 `/inbox`。
2. 点击某条消息的 `回复`。
3. 输入内容并提交。
4. 用户收到回复。
5. 管理员 Telegram 收到 Web 回复成功提醒。

### 6. 广告拦截

1. 打开 `/rules`。
2. 添加关键词，例如：

```text
测试广告
测试拉黑
```

3. 用普通用户发送包含关键词的消息。
4. 后台收件箱显示拦截错误。
5. 用户被封禁，管理员收到提醒。

### 7. D1 数据检查

```powershell
npx wrangler d1 execute tg-dualbot-db --remote --command "SELECT user_id,verified,last_http_ipv4,last_http_ipv6,last_webrtc_ipv4,last_webrtc_ipv6,last_asn FROM users ORDER BY updated_at DESC LIMIT 10"
```

```powershell
npx wrangler d1 execute tg-dualbot-db --remote --command "SELECT id,user_id,http_ip,http_ip_version,udp_status,asn,created_at FROM ip_verifications ORDER BY id DESC LIMIT 10"
```

<a id="upgrade"></a>

## 旧库升级

新部署只需要执行：

```powershell
npm run db:apply
```

如果你已经有旧版 D1 数据库，并且旧库没有验证门禁字段，可以执行：

```powershell
npm run db:upgrade:verification
```

如果旧库已经有验证门禁字段，但还没有 Telegram 话题字段，可以执行：

```powershell
npm run db:upgrade:topics
```

如果旧库已经运行过新版 Worker，运行时代码可能已经自动补齐字段；这时升级 SQL 遇到重复字段可以停止，不影响新版运行。

<a id="faq"></a>

## 常见问题

### 后台打不开

检查：

- Workers 或 Pages 是否部署成功。
- D1 Binding 是否叫 `DB`。
- `PUBLIC_BASE_URL` 是否指向当前域名。
- `/health` 是否返回 `ok`。

### Telegram 没有进入 Webhook

检查：

- `BOT_TOKEN` 是否正确。
- `setWebhook` 的 URL 是否是 `<PUBLIC_BASE_URL>/telegram/webhook`。
- `TELEGRAM_SECRET_TOKEN` 是否和 `setWebhook` 传入的一致。
- Cloudflare 运行日志是否有错误。

### 用户一直被要求验证

检查：

- `TURNSTILE_SITE_KEY` 是否配置。
- `TURNSTILE_SECRET_KEY` 是否配置。
- Turnstile Hostname 是否包含当前访问域名。
- D1 表 `users.verified` 是否被更新为 `1`。

### UDP 信息为空

这是正常可能。浏览器、代理、系统隐私设置或网络环境可能阻止 WebRTC 暴露公网 UDP 候选地址。后台会保留 `udp_status`，用来判断是成功、空、失败还是不支持。

### inline 按钮没有反应

重新设置 Telegram Webhook，并确保 `allowed_updates` 包含 `callback_query`。

### `PUBLIC_BASE_URL` 留空会怎样

后台仍能访问，但 Bot 无法生成可点击的验证链接。正式部署必须填写。

<a id="security"></a>

## 安全建议

- 不要把 `BOT_TOKEN`、`PANEL_PASSWORD`、`PANEL_SECRET`、`TELEGRAM_SECRET_TOKEN`、`TURNSTILE_SECRET_KEY` 写入 README 或提交到 GitHub。
- `wrangler.toml` 只放普通变量；敏感值使用 Cloudflare Secrets。
- `PANEL_SECRET` 建议使用随机长字符串。
- D1 Binding 名称必须是 `DB`，不要改成其他名称。
- `TELEGRAM_SECRET_TOKEN` 建议使用随机字符串，并在设置 Webhook 时同步传入。
- 使用话题模式时，`TOPIC_GROUP_ID` 必须是开启 Topics/Forum 的超级群 ID，且 Bot 需要创建话题和发送消息权限。
- Turnstile Widget 的 Hostname 要包含 Workers、Pages 或自定义域名。
- 管理员 Chat ID 示例可用 `123456789`，正式部署要换成真实管理员 ID。
