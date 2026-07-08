# TG DualBot Cloudflare

Cloudflare Workers / Pages Functions + D1 版本的 Telegram 双向机器人后台。

项目定位：把 Telegram Bot 的私聊消息接入 Cloudflare Workers 或 Pages Functions，通过 Webhook 实现用户和管理员之间的双向消息转发，并提供一个 Web 后台用于查看消息、回复用户、管理用户、维护拦截规则和查看 Cloudflare 验证 IP。

## 目录

### 功能目录

| 功能 | 跳转 |
|---|---|
| 功能总览 | [功能说明](#feature-overview) |
| 完整功能表 | [完整功能清单](#feature-list) |
| Workers / Pages 入口 | [Cloudflare Workers / Pages 入口](#runtime-entry) |
| 公开路由 | [公开路由](#public-routes) |
| 后台路由 | [后台路由](#admin-routes) |
| Telegram 双向消息和管理命令 | [Telegram Webhook 功能](#telegram-webhook) |
| Web 后台页面 | [Web 后台功能](#web-panel) |
| Cloudflare 验证和 IP 显示 | [Cloudflare Turnstile 和 IP 显示](#turnstile-ip) |
| D1 数据表 | [D1 数据表定位](#d1-schema) |
| 配置和密钥 | [配置和密钥定位](#config-secrets) |
| 关键数据流 | [关键数据流](#flows) |

### 部署目录

| 部署内容 | 跳转 |
|---|---|
| Cloudflare 服务 | [部署后会用到的 Cloudflare 服务](#cloudflare-services) |
| 部署前准备 | [部署前需要准备](#requirements) |
| 进入项目目录 | [第 1 步](#step-1) |
| 安装依赖 | [第 2 步](#step-2) |
| 登录 Cloudflare | [第 3 步](#step-3) |
| 创建 D1 数据库 | [第 4 步](#step-4) |
| 配置公开地址和 Turnstile | [第 5 步](#step-5) |
| 配置 Secrets | [第 6 步](#step-6) |
| 执行 D1 迁移 | [第 7 步](#step-7) |
| 本地语法检查 | [第 8 步](#step-8) |
| Workers 部署 | [第 9A 步](#step-9a) |
| Pages Functions 部署 | [第 9B 步](#step-9b) |
| 自定义域名 | [第 10 步](#step-10) |
| Telegram Webhook | [第 11 步](#step-11) |
| 后台初始化 | [第 12 步](#step-12) |
| 双向消息验证 | [第 13 步](#step-13) |
| 广告拦截验证 | [第 14 步](#step-14) |
| CF 验证和 IP 显示验证 | [第 15 步](#step-15) |
| 运维命令 | [第 16 步](#step-16) |
| 常见问题 | [常见问题](#faq) |
| 安全建议 | [安全建议](#security) |

### 文件目录

| 内容 | 跳转 |
|---|---|
| 完整目录定位 | [完整目录定位](#project-tree) |
| 简版文件结构 | [文件结构](#file-structure) |

<a id="feature-overview"></a>

## 功能说明

这个版本保留的是 Telegram 私聊双向机器人后台和 Cloudflare 验证能力，主要功能如下：

- Telegram 用户私聊 Bot 后，消息自动写入 D1，并转发给管理员。
- 入站消息支持文本和常见 Telegram 消息类型识别，包括 `text`、`photo`、`video`、`document`、`audio`、`voice`、`sticker` 等；转发管理员时优先使用 `copyMessage` 保留原消息形态，失败时自动降级为文本 fallback。
- 管理员可以在 Telegram 里直接回复 Bot 转发的消息，系统根据 `message_map` 自动找到原用户并回发。
- 管理员也可以使用 Telegram 命令 `/reply <user_id> <内容>` 主动按用户 ID 回复。
- Web 后台收件箱可查看入站消息、出站回复、消息方向、消息来源、转发状态和错误信息。
- Web 后台可直接回复用户，并把回复结果同步记录到收件箱。
- 转发失败的入站消息可在收件箱手动重试。
- 用户管理支持查看用户资料、备注、封禁、解封，并显示最近一次 Cloudflare 验证 IP。
- 支持最多 3 个管理员 Chat ID，可通过后台设置保存，也可通过 Cloudflare 环境变量或 Secret 兜底配置。
- 私聊广告词拦截支持一行一个关键词，命中后可自动封禁用户并通知管理员。
- Cloudflare Turnstile 验证页 `/verify` 支持独立访问，也支持 `/verify?user_id=123456789` 绑定 Telegram 用户。
- 验证通过后页面会显示访问者 IP、国家/地区、Cloudflare 机房和验证时间，并写入后台 `CF 验证记录`。
- 绑定用户的验证通过后，会更新用户管理中的最近验证 IP，并向管理员发送 Telegram 通知。
- 后台设置页可维护管理员 Chat ID、用户 `/start` 欢迎语，并检查关键 Cloudflare Secrets 是否已配置。
- 后台日志页可查看最近运行事件，`/health` 可用于健康检查。
- 后台登录使用用户名、密码和 Cookie Session；敏感值通过 Cloudflare Secrets 保存。
- 同一套业务代码同时支持 Cloudflare Workers 部署和 Cloudflare Pages Functions 部署。

<a id="feature-list"></a>

## 完整功能清单

| 功能大类 | 包含能力 | 使用入口 |
|---|---|---|
| [Telegram 用户接入](#telegram-webhook) | `/start` 注册或更新用户、返回欢迎语、返回专属 CF 验证链接 | Telegram 私聊 Bot |
| [用户消息转发](#telegram-webhook) | 用户私聊消息入库、识别消息类型、转发给所有管理员、记录转发结果 | `/telegram/webhook` |
| [Telegram 管理员回复](#telegram-webhook) | 回复 Bot 转发消息自动回给原用户；也支持 `/reply` 命令按 user_id 回复 | Telegram 管理员对话 |
| [Telegram 管理命令](#telegram-webhook) | `/block`、`/unblock`、`/note`、`/who`、`/spamwords`、`/spamadd`、`/spamdel`、`/verifylink` | Telegram 管理员对话 |
| [Web 收件箱](#web-panel) | 查看双向消息、查看错误、回复用户、重试失败转发 | `/inbox` |
| [用户管理](#web-panel) | 查看用户 ID、username、昵称、备注、封禁状态、最近验证 IP，支持备注和封禁操作 | `/users` |
| [广告拦截](#web-panel) | 维护私聊关键词，控制命中后是否自动封禁，命中后通知管理员 | `/rules` |
| [CF 验证与 IP 展示](#turnstile-ip) | Turnstile 验证、显示访问 IP、记录国家/地区、机房、User-Agent，可关联 Telegram 用户 | `/verify`、`/verifications` |
| [后台设置](#web-panel) | 配置管理员 Chat ID、修改欢迎语、查看公开地址、查看验证页、检查 Secrets 状态 | `/settings` |
| [运行日志](#web-panel) | 记录关键错误、通知失败、Turnstile 失败等事件，后台可查看最近日志 | `/logs` |
| [健康检查](#public-routes) | 返回 `ok`，用于确认 Workers 或 Pages Functions 是否可访问 | `/health` |
| [Cloudflare 部署](#step-9a) | Workers 使用 `worker.js`，Pages Functions 使用 `functions/[[path]].js` 复用同一套逻辑 | `wrangler deploy` / `wrangler pages deploy` |

<a id="project-tree"></a>

## 完整目录定位

```text
tg-dualbot-cloudflare/
├─ .gitignore
│  └─ Git 忽略规则，防止提交 node_modules、.env、.dev.vars、.wrangler 等本地或敏感文件。
├─ package.json
│  ├─ 项目包信息。
│  ├─ npm run dev：按 Workers 模式本地启动 wrangler dev。
│  ├─ npm run deploy：按 Workers 模式部署。
│  ├─ npm run pages:deploy：按 Pages Functions 模式部署。
│  ├─ npm run check：检查主 Worker 和 Pages 入口语法。
│  └─ npm run db:apply：对远程 D1 执行初始化 SQL。
├─ wrangler.toml
│  ├─ Cloudflare Workers 部署配置。
│  ├─ main = "worker.js" 指向主 Worker 入口。
│  ├─ compatibility_date 固定运行时兼容日期。
│  ├─ [[d1_databases]] 绑定 D1 数据库到 env.DB。
│  └─ [vars] 保存非敏感公开变量：PUBLIC_BASE_URL、TURNSTILE_SITE_KEY、ADMIN_CHAT_IDS。
├─ worker.js
│  ├─ 项目核心业务代码。
│  ├─ Workers 部署时由 wrangler.toml 的 main 直接加载。
│  ├─ Pages 部署时由 functions/[[path]].js 导入复用。
│  ├─ HTTP 路由分发。
│  ├─ Web 后台页面渲染。
│  ├─ Telegram Webhook 处理。
│  ├─ Telegram Bot API 调用。
│  ├─ D1 数据读写。
│  ├─ Turnstile 验证和 IP 记录。
│  └─ 登录、Cookie、日志、限流、转义等工具函数。
├─ functions/
│  └─ [[path]].js
│     ├─ Cloudflare Pages Functions 的 catch-all 入口。
│     ├─ 捕获 Pages 上的所有路径。
│     └─ 调用 ../worker.js 里的 handleRequest()，保证 Pages 和 Workers 使用同一套逻辑。
├─ public/
│  └─ .keep
│     └─ Pages 静态目录占位文件；Pages 部署上传 public，不把源码作为静态文件上传。
├─ README.md
│  └─ 项目说明、功能说明、部署步骤、运维命令、常见问题和目录定位。
└─ migrations/
   └─ 0001_initial.sql
      ├─ D1 初始化数据库结构。
      ├─ users：Telegram 用户、备注、封禁、最近验证 IP。
      ├─ message_map：管理员消息 ID 到用户 ID 的映射。
      ├─ inbox_messages：入站/出站消息记录。
      ├─ spam_keywords：广告拦截关键词。
      ├─ settings：后台配置。
      ├─ event_logs：后台日志。
      ├─ rate_events：用户限流记录。
      └─ ip_verifications：Turnstile 验证和 IP 记录。
```

<a id="feature-index"></a>

## 功能定位索引

<a id="runtime-entry"></a>

### Cloudflare Workers / Pages 入口

| 功能 | 文件位置 | 说明 |
|---|---|---|
| Workers 入口 | `worker.js` -> `export default.fetch()` | 使用 `wrangler deploy` 部署 Workers 时，从这里进入。 |
| Pages 入口 | `functions/[[path]].js` -> `onRequest()` | 使用 Pages 部署时，catch-all 函数把请求交给 `worker.js` 的 `handleRequest()`。 |
| 主路由分发 | `worker.js` -> `handleRequest()` | 按 URL 和 HTTP method 分发到 Telegram Webhook、后台页面、验证页等功能。 |
| HTML 响应工具 | `text()`、`html()`、`json()`、`redirect()` | 统一返回文本、HTML、JSON、跳转响应。 |
| HTML 转义 | `h()` | 防止用户内容直接进入后台页面造成 HTML 注入。 |
| 时间格式 | `nowIso()` | 统一使用 ISO 时间写入 D1。 |

<a id="public-routes"></a>

### 公开路由

| 路由 | 方法 | 功能 | 处理函数 |
|---|---|---|---|
| `/health` | GET | 健康检查，返回 `ok` | `text("ok")` |
| `/telegram/webhook` | POST | Telegram Webhook 入口 | `telegramWebhook()` |
| `/verify` | GET | Cloudflare Turnstile 验证页面 | `verifyPage()` |
| `/verify` | POST | 提交 Turnstile 验证并显示 IP | `verifySubmit()` |
| `/login` | GET | 后台登录页 | `loginPage()` |
| `/login` | POST | 后台登录提交 | `loginSubmit()` |
| `/logout` | GET | 退出后台 | 清除 `tg_dualbot_session` Cookie |

<a id="admin-routes"></a>

### 后台路由

这些路由需要先登录后台。

| 路由 | 方法 | 功能 | 处理函数 |
|---|---|---|---|
| `/` | GET | 后台总览，显示用户数、封禁数、消息数、验证数 | `dashboard()` |
| `/inbox` | GET | 收件箱，显示入站/出站消息和转发状态 | `inboxPage()` |
| `/inbox/{id}/reply` | GET | 打开某条消息的回复页面 | `inboxReplyPage()` |
| `/inbox/{id}/reply` | POST | 从 Web 后台回复用户 | `inboxReplySave()` |
| `/inbox/{id}/retry` | POST | 重试转发失败的入站消息 | `retryInbox()` |
| `/users` | GET | 用户列表、备注、封禁状态、最近验证 IP | `usersPage()` |
| `/users/{user_id}/note` | POST | 保存用户备注 | `userNoteSave()` |
| `/users/{user_id}/block` | POST | 封禁用户 | `userBlockSet(..., true)` |
| `/users/{user_id}/unblock` | POST | 解封用户 | `userBlockSet(..., false)` |
| `/rules` | GET | 广告拦截规则页面 | `rulesPage()` |
| `/rules` | POST | 保存广告关键词和自动封禁设置 | `rulesSave()` |
| `/verifications` | GET | Cloudflare 验证 IP 记录 | `verificationsPage()` |
| `/settings` | GET | 后台设置页，显示管理员 ID、欢迎语、Secrets 状态 | `settingsPage()` |
| `/settings` | POST | 保存管理员 ID 和欢迎语 | `settingsSave()` |
| `/logs` | GET | 查看最近后台日志 | `logsPage()` |

<a id="telegram-webhook"></a>

### Telegram Webhook 功能

| 功能 | 处理函数 | 过程 |
|---|---|---|
| Webhook 安全校验 | `telegramWebhook()` | 如果配置了 `TELEGRAM_SECRET_TOKEN`，校验 Telegram 请求头 `X-Telegram-Bot-Api-Secret-Token`。 |
| Telegram update 分发 | `handleTelegramUpdate()` | 判断消息来源、命令、管理员回复、普通用户私聊。 |
| `/start` | `handleCommand()` | 写入用户，回复欢迎语，并附带 `/verify?user_id=...` 验证链接。 |
| `/verify` | `handleCommand()` | 给用户返回专属 Cloudflare 验证链接。 |
| 管理员 `/reply` | `handleCommand()` | 管理员用 `/reply <user_id> <内容>` 发送给用户。 |
| 管理员 `/block` | `handleCommand()` | 封禁指定用户。 |
| 管理员 `/unblock` | `handleCommand()` | 解封指定用户。 |
| 管理员 `/note` | `handleCommand()` | 给指定用户写备注。 |
| 管理员 `/who` | `handleCommand()` | 查询指定用户信息和最近验证 IP。 |
| 管理员 `/spamwords` | `handleCommand()` | 查看广告关键词。 |
| 管理员 `/spamadd` | `handleCommand()` | 添加广告关键词。 |
| 管理员 `/spamdel` | `handleCommand()` | 删除广告关键词。 |
| 管理员 `/verifylink` | `handleCommand()` | 给指定 user_id 生成验证链接。 |
| 用户普通消息 | `relayUserMessage()` | 写入用户和消息，检查封禁/限流/广告词，然后转发给管理员。 |
| 管理员回复转发消息 | `adminReplyByMessage()` | 根据 `message_map` 找到原用户，把管理员回复发回用户。 |

<a id="web-panel"></a>

### Web 后台功能

| 页面 | 作用 | 数据来源 |
|---|---|---|
| 总览 | 用户数、封禁数、消息记录数、验证通过数 | `users`、`inbox_messages`、`ip_verifications` |
| 收件箱 | 查看所有入站和出站消息，回复用户，重试失败转发 | `inbox_messages`、`message_map` |
| 用户管理 | 查看用户资料、备注、封禁/解封、最近验证 IP | `users` |
| 广告拦截 | 管理私聊广告关键词，控制命中后是否自动封禁 | `spam_keywords`、`settings.spam_auto_block` |
| CF 验证记录 | 查看通过 Turnstile 的 IP、国家、机房、User-Agent | `ip_verifications`、`users` |
| 设置 | 配置管理员 Chat ID、欢迎语，查看 Secrets 配置状态 | `settings`、运行环境 env |
| 日志 | 查看运行时记录的最近事件 | `event_logs` |

<a id="turnstile-ip"></a>

### Cloudflare Turnstile 和 IP 显示

| 功能 | 处理函数 | 说明 |
|---|---|---|
| 验证页渲染 | `verifyPage()` | 显示 Turnstile Widget，支持 `?user_id=` 关联 Telegram 用户。 |
| 验证提交 | `verifySubmit()` | 调用 `https://challenges.cloudflare.com/turnstile/v0/siteverify` 校验 token。 |
| 访客 IP 获取 | `visitorIp()` | 优先读取 `CF-Connecting-IP`，其次读取 `X-Forwarded-For`。 |
| 验证记录 | `verifySubmit()` | 写入 `ip_verifications` 表。 |
| 用户最近 IP | `verifySubmit()` | 如果带 `user_id`，更新 `users.last_verified_ip`、`last_verified_at`、`last_cf_country`。 |
| 管理员通知 | `notifyAdmins()` | 验证通过后给管理员发送 `[CF 验证通过]` 通知。 |

<a id="d1-schema"></a>

### D1 数据表定位

| 表 | 字段重点 | 负责功能 |
|---|---|---|
| `users` | `user_id`、`username`、`full_name`、`note`、`blocked`、`last_verified_ip` | 用户管理、封禁、备注、验证 IP 展示 |
| `message_map` | `admin_chat_id`、`admin_message_id`、`user_id`、`user_message_id` | 管理员 Telegram 回复映射到原用户 |
| `inbox_messages` | `direction`、`source`、`message_type`、`text`、`forwarded`、`error` | 收件箱、Web 回复、失败重试、对话历史 |
| `spam_keywords` | `keyword` | 私聊广告词拦截 |
| `settings` | `key`、`value` | 管理员 Chat ID、欢迎语、广告拦截开关 |
| `event_logs` | `level`、`message`、`data` | 后台日志 |
| `rate_events` | `user_id`、`ts` | 用户私聊限流 |
| `ip_verifications` | `user_id`、`ip`、`country`、`colo`、`user_agent` | Turnstile 验证记录和 IP 展示 |

<a id="config-secrets"></a>

### 配置和密钥定位

| 名称 | 类型 | 位置 | 作用 |
|---|---|---|---|
| `DB` | D1 binding | `wrangler.toml` -> `[[d1_databases]]` | 运行时代码通过 `env.DB` 访问 D1。 |
| `PUBLIC_BASE_URL` | 普通变量 | `wrangler.toml` -> `[vars]` | 生成 Webhook 地址和用户验证链接。 |
| `TURNSTILE_SITE_KEY` | 普通变量 | `wrangler.toml` -> `[vars]` | 前端显示 Turnstile Widget。 |
| `ADMIN_CHAT_IDS` | 普通变量或 Secret | `wrangler.toml` / Cloudflare Secret | 管理员 Chat ID fallback。 |
| `BOT_TOKEN` | Secret | `wrangler secret put BOT_TOKEN` | Telegram Bot API 调用。 |
| `PANEL_USER` | Secret，可选 | `wrangler secret put PANEL_USER` | 后台用户名，不设置默认 `admin`。 |
| `PANEL_PASSWORD` | Secret | `wrangler secret put PANEL_PASSWORD` | 后台登录密码。 |
| `PANEL_SECRET` | Secret | `wrangler secret put PANEL_SECRET` | 后台 Cookie session 签名。 |
| `TELEGRAM_SECRET_TOKEN` | Secret | `wrangler secret put TELEGRAM_SECRET_TOKEN` | Telegram Webhook 请求校验。 |
| `TURNSTILE_SECRET_KEY` | Secret | `wrangler secret put TURNSTILE_SECRET_KEY` | Turnstile 服务端校验。 |

<a id="flows"></a>

### 关键数据流

#### 用户发消息到管理员

```text
Telegram 用户私聊 Bot
  -> Telegram Webhook POST /telegram/webhook
  -> telegramWebhook()
  -> handleTelegramUpdate()
  -> relayUserMessage()
  -> upsertUser()
  -> createInboxMessage()
  -> spamHits() / rateLimited() / isBlocked()
  -> relayStoredInboxToAdmins()
  -> tgCall(sendMessage/copyMessage)
  -> saveMessageMap()
  -> markInboxForwarded()
```

#### 管理员 Telegram 回复用户

```text
管理员回复 Bot 转发消息
  -> Telegram Webhook POST /telegram/webhook
  -> handleTelegramUpdate()
  -> adminReplyByMessage()
  -> message_map 查 user_id
  -> sendTextToUser()
  -> tgCall(sendMessage)
  -> createOutboxMessage()
```

#### Web 后台回复用户

```text
管理员打开 /inbox/{id}/reply
  -> inboxReplyPage()
  -> POST /inbox/{id}/reply
  -> inboxReplySave()
  -> sendTextToUser()
  -> createOutboxMessage()
  -> notifyAdmins()
```

#### Cloudflare 验证并显示 IP

```text
访问 /verify 或 /verify?user_id=123456789
  -> verifyPage()
  -> Turnstile 前端验证
  -> POST /verify
  -> verifySubmit()
  -> Turnstile siteverify
  -> visitorIp() 读取 CF-Connecting-IP
  -> 写入 ip_verifications
  -> 如果有 user_id，更新 users 最近验证 IP
  -> notifyAdmins()
  -> 页面显示访问 IP
```

<a id="cloudflare-services"></a>

## 部署后会用到的 Cloudflare 服务

| 服务 | 作用 |
|---|---|
| Cloudflare Workers | Workers 部署模式：运行 Telegram Webhook、Web 后台和验证页 |
| Cloudflare D1 | 保存用户、消息、映射关系、广告词、设置、日志、验证记录 |
| Cloudflare Turnstile | 提供 CF 验证，验证通过后显示并记录访问 IP |
| Cloudflare Secrets | 保存 Bot Token、后台密码、Webhook Secret、Turnstile Secret 等敏感信息 |
| Cloudflare Pages | Pages 部署模式：通过 `functions/[[path]].js` 运行同一套后台逻辑 |
| workers.dev、pages.dev 或自定义域名 | 作为后台和 Telegram Webhook 的公网 HTTPS 地址 |

<a id="requirements"></a>

## 部署前需要准备

1. Cloudflare 账号。
2. 已登录的 Telegram 账号。
3. 一个 Telegram Bot Token。
4. 你的 Telegram 管理员 Chat ID。
5. Node.js 18 或更高版本。
6. npm。
7. 可以访问 Cloudflare 和 Telegram API 的网络环境。

### 获取 Telegram Bot Token

1. 打开 Telegram，找到 `@BotFather`。
2. 发送 `/newbot`。
3. 按提示设置 Bot 名称和用户名。
4. BotFather 会返回一个类似下面格式的 Token：

```text
123456789:示例占位符
```

这个值后面写入 `BOT_TOKEN` Secret。

### 获取管理员 Chat ID

推荐方法：

1. 先给你的 Bot 发送 `/start`。
2. 打开下面地址，把 `<BOT_TOKEN>` 换成你的 Bot Token：

```text
https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
```

3. 在返回 JSON 中找到你的消息，里面的 `message.chat.id` 就是管理员 Chat ID。

示例：

```json
{
  "message": {
    "chat": {
      "id": 123456789
    }
  }
}
```

如果有多个管理员，最多填写 3 个，用英文逗号分隔：

```text
123456789,987654321,1122334455
```

### 创建 Cloudflare Turnstile

1. 登录 Cloudflare Dashboard。
2. 进入 `Turnstile`。
3. 点击 `Add widget`。
4. Widget name 可填：`tg-dualbot-verify`。
5. Widget mode 建议选择 `Managed`。
6. Hostname 添加你的 Workers、Pages 或自定义域名。
   - 如果先用 workers.dev，可以部署后再回到这里补域名。
   - 如果已有自定义域名，可以直接填自定义域名。
7. 创建后记录两个值：
   - `Site Key`：写入 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`。
   - `Secret Key`：写入 Cloudflare Secret `TURNSTILE_SECRET_KEY`。

<a id="step-1"></a>

## 第 1 步：进入项目目录

PowerShell：

```powershell
cd 'E:\多功能telegram双向机器人\tg-dualbot-cloudflare'
```

确认文件存在：

```powershell
Get-ChildItem
```

你应该能看到：

```text
package.json
wrangler.toml
README.md
worker.js
functions
public
migrations
```

<a id="step-2"></a>

## 第 2 步：安装依赖

```powershell
npm install
```

这会安装 Wrangler，用于创建 D1、写入 Secrets 和部署 Worker。

<a id="step-3"></a>

## 第 3 步：登录 Cloudflare

```powershell
npx wrangler login
```

执行后浏览器会打开 Cloudflare 授权页面。授权完成后回到终端。

验证登录状态：

```powershell
npx wrangler whoami
```

如果能看到你的 Cloudflare 账号信息，说明 Wrangler 已登录。

<a id="step-4"></a>

## 第 4 步：创建 D1 数据库

```powershell
npx wrangler d1 create tg-dualbot-db
```

命令会输出类似内容：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tg-dualbot-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

复制输出里的 `database_id`。

然后编辑 `wrangler.toml`，把：

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

替换为真实 ID：

```toml
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

注意：`binding` 必须保持为 `DB`，因为代码里使用的是 `env.DB`。

<a id="step-5"></a>

## 第 5 步：配置公开地址和 Turnstile Site Key

编辑 `wrangler.toml` 的 `[vars]`：

```toml
[vars]
PUBLIC_BASE_URL = "https://你的域名或 workers.dev 地址"
TURNSTILE_SITE_KEY = "你的 Turnstile Site Key"
ADMIN_CHAT_IDS = ""
```

### PUBLIC_BASE_URL 怎么填

如果使用 workers.dev，通常格式是：

```text
https://tg-dualbot-cloudflare.<你的 workers.dev 子域>.workers.dev
```

如果你还不知道最终 workers.dev 地址，可以先留空部署一次，部署完成后 Wrangler 会输出访问地址。拿到地址后再填回 `PUBLIC_BASE_URL`，然后重新部署一次。

如果使用自定义域名，例如：

```text
https://bot.example.com
```

则填：

```toml
PUBLIC_BASE_URL = "https://bot.example.com"
```

`PUBLIC_BASE_URL` 用于生成：

- Telegram Webhook URL。
- 用户 CF 验证链接 `/verify?user_id=...`。
- 后台显示的公开地址。

### TURNSTILE_SITE_KEY 怎么填

把 Cloudflare Turnstile 页面里的 `Site Key` 填进去：

```toml
TURNSTILE_SITE_KEY = "0x4AAAAA..."
```

`TURNSTILE_SECRET_KEY` 不要写进 `wrangler.toml`，后面用 Secret 写入。

<a id="step-6"></a>

## 第 6 步：配置 Cloudflare Secrets

下面这些值属于敏感信息，必须用 Wrangler Secret 写入。

### BOT_TOKEN

Telegram Bot Token：

```powershell
npx wrangler secret put BOT_TOKEN
```

提示输入时粘贴 BotFather 给你的 Token。

### PANEL_PASSWORD

Web 后台登录密码：

```powershell
npx wrangler secret put PANEL_PASSWORD
```

建议使用强密码。

后台默认用户名是：

```text
admin
```

如果要改后台用户名，可以额外设置：

```powershell
npx wrangler secret put PANEL_USER
```

不设置则默认 `admin`。

### PANEL_SECRET

后台 Cookie Session 签名用随机密钥：

```powershell
npx wrangler secret put PANEL_SECRET
```

建议生成一个 32 位以上随机字符串，例如：

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

把生成结果复制后写入 `PANEL_SECRET`。

### TELEGRAM_SECRET_TOKEN

Telegram Webhook 请求校验密钥：

```powershell
npx wrangler secret put TELEGRAM_SECRET_TOKEN
```

建议同样使用随机字符串。后面调用 Telegram `setWebhook` 时要使用同一个值。

### TURNSTILE_SECRET_KEY

Cloudflare Turnstile Secret Key：

```powershell
npx wrangler secret put TURNSTILE_SECRET_KEY
```

输入 Turnstile 页面里的 `Secret Key`。

### ADMIN_CHAT_IDS

管理员 Chat ID 可以二选一配置：

方式 A：部署后进后台设置页面填写。

方式 B：先用 Secret 写入：

```powershell
npx wrangler secret put ADMIN_CHAT_IDS
```

多个管理员用英文逗号分隔：

```text
123456789,987654321
```

<a id="step-7"></a>

## 第 7 步：执行 D1 数据库迁移

```powershell
npx wrangler d1 execute tg-dualbot-db --file=./migrations/0001_initial.sql --remote
```

成功后会创建这些表：

| 表 | 作用 |
|---|---|
| `users` | Telegram 用户、备注、封禁状态、最近验证 IP |
| `message_map` | 管理员回复消息和原用户的映射关系 |
| `inbox_messages` | 入站和出站消息记录 |
| `spam_keywords` | 广告拦截关键词 |
| `settings` | 后台配置，例如管理员 ID、欢迎语 |
| `event_logs` | 后台日志 |
| `rate_events` | 用户发送频率限制记录 |
| `ip_verifications` | CF Turnstile 验证和 IP 记录 |

如果后续需要重跑迁移，D1 里的 `CREATE TABLE IF NOT EXISTS` 不会重复创建表。

<a id="step-8"></a>

## 第 8 步：本地语法检查

```powershell
npm run check
```

等价于：

```powershell
node --check worker.js && node --check functions\[[path]].js
```

如果没有输出错误，说明 Workers 主入口和 Pages Functions 入口语法正常。

<a id="step-9a"></a>

## 第 9A 步：部署到 Cloudflare Workers

```powershell
npx wrangler deploy
```

部署完成后，终端会输出 Worker 地址，例如：

```text
https://tg-dualbot-cloudflare.xxx.workers.dev
```

如果你之前 `PUBLIC_BASE_URL` 还是空的，现在把这个地址写回 `wrangler.toml`：

```toml
PUBLIC_BASE_URL = "https://tg-dualbot-cloudflare.xxx.workers.dev"
```

然后重新部署一次：

```powershell
npx wrangler deploy
```

<a id="step-9b"></a>

## 第 9B 步：部署到 Cloudflare Pages Functions

如果你想使用 Cloudflare Pages 部署，也可以使用同一套业务代码。

Pages 部署模式的入口是：

```text
functions/[[path]].js
```

这个文件会捕获 Pages 上的所有路径，并调用主目录 `worker.js` 中的 `handleRequest()`。因此 Workers 和 Pages 两种部署模式的功能一致。

### Pages 部署前需要额外确认

Pages 项目也需要同样的绑定和环境变量：

| 名称 | 类型 | Pages 中如何配置 |
|---|---|---|
| `DB` | D1 binding | Pages 项目 Settings -> Functions -> D1 database bindings，绑定名必须是 `DB` |
| `PUBLIC_BASE_URL` | Environment variable | Pages 项目 Settings -> Environment variables |
| `TURNSTILE_SITE_KEY` | Environment variable | Pages 项目 Settings -> Environment variables |
| `ADMIN_CHAT_IDS` | Environment variable 或 Secret | 可在 Pages 环境变量里设置，也可登录后台设置 |
| `BOT_TOKEN` | Secret | `wrangler pages secret put BOT_TOKEN --project-name tg-dualbot-cloudflare` |
| `PANEL_USER` | Secret，可选 | `wrangler pages secret put PANEL_USER --project-name tg-dualbot-cloudflare` |
| `PANEL_PASSWORD` | Secret | `wrangler pages secret put PANEL_PASSWORD --project-name tg-dualbot-cloudflare` |
| `PANEL_SECRET` | Secret | `wrangler pages secret put PANEL_SECRET --project-name tg-dualbot-cloudflare` |
| `TELEGRAM_SECRET_TOKEN` | Secret | `wrangler pages secret put TELEGRAM_SECRET_TOKEN --project-name tg-dualbot-cloudflare` |
| `TURNSTILE_SECRET_KEY` | Secret | `wrangler pages secret put TURNSTILE_SECRET_KEY --project-name tg-dualbot-cloudflare` |

注意：`wrangler.toml` 主要服务 Workers 部署。Pages 项目在 Cloudflare Dashboard 中也要配置对应的 D1 binding、环境变量和 Secrets，尤其是 D1 绑定名必须叫 `DB`。

### 创建 Pages 项目

如果还没有 Pages 项目，可以先创建：

```powershell
npx wrangler pages project create tg-dualbot-cloudflare --production-branch main
```

如果项目已经存在，可以跳过。

### 写入 Pages Secrets

示例：

```powershell
npx wrangler pages secret put BOT_TOKEN --project-name tg-dualbot-cloudflare
npx wrangler pages secret put PANEL_PASSWORD --project-name tg-dualbot-cloudflare
npx wrangler pages secret put PANEL_SECRET --project-name tg-dualbot-cloudflare
npx wrangler pages secret put TELEGRAM_SECRET_TOKEN --project-name tg-dualbot-cloudflare
npx wrangler pages secret put TURNSTILE_SECRET_KEY --project-name tg-dualbot-cloudflare
```

如果要改后台用户名：

```powershell
npx wrangler pages secret put PANEL_USER --project-name tg-dualbot-cloudflare
```

### 部署 Pages

项目提供了脚本：

```powershell
npm run pages:deploy
```

等价于：

```powershell
npx wrangler pages deploy public --project-name tg-dualbot-cloudflare
```

这里上传的是 `public/` 静态目录，业务请求由 `functions/[[path]].js` 接管。这样不会把 `worker.js`、`README.md`、`wrangler.toml` 等源码文件作为静态资源上传。

部署完成后，终端会输出 Pages 地址，例如：

```text
https://tg-dualbot-cloudflare.pages.dev
```

把这个地址写入 Pages 项目的 `PUBLIC_BASE_URL` 环境变量，或如果继续使用 Workers 模式，则写入 `wrangler.toml`。

使用 Pages 地址时，Telegram Webhook 应设置为：

```text
https://tg-dualbot-cloudflare.pages.dev/telegram/webhook
```

<a id="step-10"></a>

## 第 10 步：配置自定义域名，可选

如果你只使用 `workers.dev` 或 `pages.dev`，可以跳过此步。

如果要绑定自己的域名，例如 `bot.example.com`，按你的部署模式处理：

| 部署模式 | 配置位置 | 配置完成后要做什么 |
|---|---|---|
| Workers | Cloudflare Dashboard -> Workers & Pages -> 对应 Worker -> Settings -> Triggers -> Custom Domains | 把 `PUBLIC_BASE_URL` 改成自定义域名后重新 `npx wrangler deploy` |
| Pages Functions | Cloudflare Dashboard -> Workers & Pages -> 对应 Pages 项目 -> Custom domains | 把 Pages 项目的 `PUBLIC_BASE_URL` 环境变量改成自定义域名后重新部署 Pages |

Workers 模式示例：

```toml
PUBLIC_BASE_URL = "https://bot.example.com"
```

重新部署 Workers：

```powershell
npx wrangler deploy
```

Pages 模式则在 Pages 项目环境变量中把 `PUBLIC_BASE_URL` 设置为：

```text
https://bot.example.com
```

然后重新部署：

```powershell
npm run pages:deploy
```

无论使用 Workers 还是 Pages，都要同时回到 Turnstile Widget，把 `bot.example.com` 添加到允许的 Hostname，并把 Telegram Webhook 更新成：

```text
https://bot.example.com/telegram/webhook
```

<a id="step-11"></a>

## 第 11 步：设置 Telegram Webhook

准备三个值：

```powershell
$BOT_TOKEN = "你的 Bot Token"
$PUBLIC_BASE_URL = "https://你的 Workers、Pages 或自定义域名地址"
$TELEGRAM_SECRET_TOKEN = "你写入 TELEGRAM_SECRET_TOKEN 的同一个值"
```

设置 Webhook：

```powershell
curl.exe "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" `
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" `
  -d "secret_token=$TELEGRAM_SECRET_TOKEN" `
  -d "allowed_updates=[\"message\",\"edited_message\"]"
```

成功时会返回类似：

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

检查 Webhook：

```powershell
curl.exe "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

重点看：

```json
{
  "ok": true,
  "result": {
    "url": "https://你的地址/telegram/webhook",
    "pending_update_count": 0
  }
}
```

如果 `last_error_message` 不为空，说明 Telegram 调用 Workers 或 Pages Functions 失败，需要检查 Workers 或 Pages 地址、Secret Token、部署状态或 Cloudflare 日志。

<a id="step-12"></a>

## 第 12 步：打开后台并完成初始化

打开：

```text
https://你的 Workers 或 Pages 地址/
```

登录：

```text
用户名：admin
密码：PANEL_PASSWORD 里设置的密码
```

如果设置了 `PANEL_USER`，用户名就是你设置的值。

登录后进入 `设置`：

1. 填写管理员 Telegram Chat ID。
2. 可修改 `/start` 欢迎语。
3. 保存。

如果你已经用 `ADMIN_CHAT_IDS` Secret 配置过管理员，也可以不填，后台会优先使用 D1 设置中的管理员 ID，D1 没有时使用 Secret 中的 `ADMIN_CHAT_IDS`。

<a id="step-13"></a>

## 第 13 步：验证 Telegram 双向消息

### 用户发消息

1. 用普通用户账号打开 Bot。
2. 发送 `/start`。
3. 再发送一条普通消息，例如：

```text
你好，这是测试消息
```

预期结果：

- 管理员 Telegram 收到 `[用户消息 #id]`。
- 管理员收到用户原消息的 copy 或文本 fallback。
- 后台 `收件箱` 出现这条消息。

### 管理员回复用户

管理员在 Telegram 里直接回复 Bot 转发来的用户消息，例如：

```text
收到，已处理。
```

预期结果：

- 用户收到管理员回复。
- 后台 `收件箱` 出现一条 `管理员 -> 用户` 的出站记录。

### Web 后台回复用户

1. 打开后台 `收件箱`。
2. 找到用户消息。
3. 点击 `回复`。
4. 输入回复内容并提交。

预期结果：

- 用户收到消息。
- 管理员 Telegram 收到 Web 回复成功提醒。
- 后台记录出站消息。

<a id="step-14"></a>

## 第 14 步：验证广告拦截

1. 打开后台 `广告拦截`。
2. 添加关键词，例如：

```text
博彩
投资
空投
```

3. 保存。
4. 用普通用户发送包含关键词的私聊消息。

预期结果：

- 消息被标记为已拦截。
- 用户被自动封禁，除非你关闭了自动封禁。
- 管理员收到拦截通知。
- 后台用户管理里该用户状态变成封禁。

<a id="step-15"></a>

## 第 15 步：验证 Cloudflare Turnstile 和 IP 显示

### 普通验证页

打开：

```text
https://你的 Workers 或 Pages 地址/verify
```

通过 Turnstile 后，页面会显示：

- 访问 IP。
- Cloudflare 国家/地区。
- Cloudflare 机房 colo。
- 验证时间。

后台 `CF 验证记录` 会出现一条记录。

### 绑定 Telegram 用户的验证页

打开：

```text
https://你的 Workers 或 Pages 地址/verify?user_id=123456789
```

把 `123456789` 换成真实 Telegram 用户 ID。

通过验证后：

- 页面显示对方 IP。
- 后台 `CF 验证记录` 关联该用户。
- 后台 `用户管理` 中该用户会显示最近验证 IP。
- 管理员 Telegram 会收到 `[CF 验证通过]` 通知。

用户也可以在 Telegram 里发送：

```text
/verify
```

Bot 会返回带 `user_id` 的专属验证链接。这个链接依赖 `PUBLIC_BASE_URL`，所以必须正确配置。

<a id="step-16"></a>

## 第 16 步：常用运维命令

查看 Worker 实时日志：

```powershell
npx wrangler tail
```

查看 D1 表数据，示例：

```powershell
npx wrangler d1 execute tg-dualbot-db --remote --command "SELECT id,user_id,ip,country,created_at FROM ip_verifications ORDER BY id DESC LIMIT 10"
```

查看用户：

```powershell
npx wrangler d1 execute tg-dualbot-db --remote --command "SELECT user_id,username,full_name,blocked,last_verified_ip FROM users ORDER BY updated_at DESC LIMIT 20"
```

重新部署：

```powershell
npx wrangler deploy
```

更新 Secret：

```powershell
npx wrangler secret put SECRET_NAME
```

<a id="faq"></a>

## 常见问题

### 1. 后台打不开

检查：

- `npx wrangler deploy` 是否成功。
- Workers 或 Pages 地址是否正确。
- 自定义域名证书是否生效。
- Cloudflare Dashboard 里 Workers 或 Pages Functions 是否有报错。

### 2. 登录失败

检查：

- 用户名默认是 `admin`。
- `PANEL_PASSWORD` Secret 是否设置正确。
- 如果设置了 `PANEL_USER`，登录用户名要用 `PANEL_USER`。
- 修改 Secret 后建议重新部署或等待配置生效。

### 3. Telegram 收不到消息

检查：

- `BOT_TOKEN` 是否正确。
- `getWebhookInfo` 中 URL 是否是 `/telegram/webhook`。
- `TELEGRAM_SECRET_TOKEN` 是否和 `setWebhook` 传入的一致。
- Workers 或 Pages Functions 是否能访问 Telegram API。
- 管理员 Chat ID 是否配置。

### 4. 管理员回复没有回到用户

管理员必须“回复 Bot 转发出来的那条用户消息”或它上方的用户消息 copy。系统依靠 `message_map` 表记录管理员消息 ID 和用户 ID 的对应关系。

如果普通发一条管理员消息，系统不会自动转发。

### 5. Turnstile 显示失败

检查：

- `TURNSTILE_SITE_KEY` 是否写在 `wrangler.toml`。
- `TURNSTILE_SECRET_KEY` 是否用 Wrangler Secret 写入。
- Turnstile Widget 的 Hostname 是否包含当前 Workers、Pages 或自定义域名。
- 浏览器是否能访问 `https://challenges.cloudflare.com`。

### 6. 验证通过但用户管理页没显示 IP

检查验证链接是否带了 `user_id`：

```text
/verify?user_id=123456789
```

如果只是访问 `/verify`，后台会记录 IP，但不会关联到 Telegram 用户。

### 7. PUBLIC_BASE_URL 留空会怎样

后台仍可打开，Telegram webhook 也可以手动设置，但 Bot 生成 `/verify` 专属链接时会失败。所以正式部署必须配置 `PUBLIC_BASE_URL`。

<a id="file-structure"></a>

## 文件结构

```text
tg-dualbot-cloudflare/
  package.json
  wrangler.toml
  README.md
  worker.js
  functions/
    [[path]].js
  public/
    .keep
  migrations/
    0001_initial.sql
```

## 本地检查

```powershell
npm run check
```

<a id="security"></a>

## 安全建议

- `BOT_TOKEN`、`PANEL_PASSWORD`、`PANEL_SECRET`、`TELEGRAM_SECRET_TOKEN`、`TURNSTILE_SECRET_KEY` 必须放在 Cloudflare Secrets，不要写进 Git。
- 后台密码使用强密码。
- `PANEL_SECRET` 使用长随机字符串。
- 如果换了域名，记得同步更新 `PUBLIC_BASE_URL`、Turnstile Hostname 和 Telegram Webhook；Pages 模式要在 Pages 环境变量中同步更新。
- 定期查看 `npx wrangler tail` 和后台日志。
