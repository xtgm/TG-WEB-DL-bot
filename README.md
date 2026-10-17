# TG DualBot Cloudflare

一句话介绍：这是一个支持 Cloudflare Workers 和 Cloudflare Pages Functions 部署的 Telegram 私聊双向机器人后台，提供用户消息转发、管理员回复、Web 管理面板、Telegram 群话题双通道控制、广告拦截、Cloudflare Turnstile 验证门禁以及 IPv4/IPv6/UDP WebRTC 记录。

## 目录

| 内容 | 跳转 |
|---|---|
| 环境变量完整说明 | [环境变量完整说明](#env-vars) |
| D1 数据库初始化和建表 | [D1 数据库初始化和建表](#d1-setup) |
| Workers 手动复制部署 | [Workers 手动复制部署](#workers-manual) |
| Workers + GitHub 部署 | [Workers + GitHub 部署](#workers-github) |
| Pages + GitHub 部署 | [Pages + GitHub 部署](#pages-github) |
| 项目定位 | [项目定位](#project-position) |
| 功能总览 | [功能总览](#feature-overview) |
| Web 面板功能 | [Web 面板功能](#web-panel) |
| 名单管理 | [名单管理](#moderation) |
| Telegram 功能 | [Telegram 功能](#telegram-features) |
| Cloudflare 验证门禁 | [Cloudflare 验证门禁](#cloudflare-verification) |
| Telegram 话题双通道 | [Telegram 话题双通道](#topic-mode) |
| 路由表 | [路由表](#routes) |
| 数据表 | [数据表](#database) |
| 完整目录定位 | [完整目录定位](#project-tree) |
| 配置项和密钥 | [配置项和密钥](#config) |
| 新部署准备 | [新部署准备](#requirements) |
| Workers CLI 部署 | [Workers CLI 部署](#workers-cli) |
| Pages Direct Upload 部署 | [Pages Direct Upload 部署](#pages-upload) |
| Telegram Webhook 设置 | [Telegram Webhook 设置](#telegram-webhook-setup) |
| 部署后验证 | [部署后验证](#post-deploy-check) |
| 旧库升级 | [旧库升级](#upgrade) |
| Cron 触发器 | [Cron 触发器](#cron) |
| 常见问题 | [常见问题](#faq) |
| 安全建议 | [安全建议](#security) |

<a id="env-vars"></a>

## 环境变量完整说明

无论使用 Workers 手动复制部署、Workers + GitHub 部署，还是 Pages + GitHub 部署，都先按这一节准备 Cloudflare 配置。示例值可以照格式填写，正式部署时把域名、Token、密码和管理员 ID 换成你自己的真实值。

### 必须绑定的 Cloudflare 资源

| 类型 | 名称 | 必填 | 说明 |
|---|---|---|---|
| D1 Binding | `DB` | 是 | 绑定到你的 D1 数据库，例如 `tg-dualbot-db`。Binding 名称必须是 `DB`，否则代码无法访问数据库。 |

### 普通变量

普通变量全部在 Cloudflare Dashboard 的「设置 → 变量和机密」里填写，本项目的 `wrangler.toml` 刻意不写 `[vars]`。

| 变量名 | 示例 | 必填 | 使用方法 |
|---|---|---|---|
| `PUBLIC_BASE_URL` | `https://tg-dualbot-cloudflare.example.workers.dev` | 是 | 部署后的公开访问地址，用于生成 Telegram 验证链接和设置 Webhook。首次部署不知道地址时可以先留空，拿到地址后必须补上并重新部署。 |
| `TURNSTILE_SITE_KEY` | `0x4AAAAA_example` | 是 | Cloudflare Turnstile 前端 Site Key，验证页面会用它显示验证组件。 |
| `ADMIN_CHAT_IDS` | `123456789,987654321` | 是 | 管理员 Telegram Chat ID，多个用英文逗号分隔，最多取前 3 个；Web 后台设置页也可以保存。 |
| `CONTROL_MODE` | `both` | 否 | 控制通道：`web` 只用 Web/管理员私聊，`topic` 只用 Telegram 话题，`both` 两边同时启用。默认 `web`。 |
| `TOPIC_GROUP_ID` | `-1001234567890` | 话题模式必填 | 开启 Topics/Forum 的 Telegram 超级群 ID。只有 `CONTROL_MODE=topic` 或 `both` 时需要。 |
| `TOPIC_CREATE_POLICY` | `after_verify` | 否 | 话题创建策略：`after_verify` 表示验证通过后创建，`first_message` 表示用户首条消息时创建。默认 `after_verify`。 |
| `TOPIC_SYNC_WEB_REPLIES` | `true` | 否 | 是否把 Web 后台和管理员私聊回复同步写入用户专属话题。默认 `true`。 |
| `FP_WEAK_SUSPECT_ENABLED` | `false` | 否 | 指纹弱证据档（规则 6）开关，默认关闭。开启后「稳定不变量一致但网络层无交集」也会列为候选。后台设置页保存的值优先。 |
| `FP_AUTO_BLOCK_ENABLED` | `false` | 否 | 指纹自动拉黑开关，默认关闭。仅对「指纹黑名单」状态的标签生效。后台设置页保存的值优先。 |
| `FP_AUTO_BLOCK_MIN_SCORE` | `95` | 否 | 自动拉黑的最低分数，取值 60~100。仅在自动拉黑开启时生效。 |

Dashboard 填写位置：Worker → **设置** → **变量和机密**，键名用上表的变量名，值照着示例列填。

`wrangler.toml` 里不要加 `[vars]`：`wrangler deploy` 会用配置文件里的值覆盖 Dashboard 上的同名变量。写成空值就会把线上配置清空，机器人会因为缺少 `PUBLIC_BASE_URL` 和 `TURNSTILE_SITE_KEY` 而直接失效，而且不会报任何错。

### Secrets

Secrets 不要写进 `wrangler.toml`、README、GitHub 仓库或截图里，只在 Cloudflare Dashboard 或 Wrangler Secret 命令里填写。

| Secret 名称 | 示例格式 | 必填 | 使用方法 |
|---|---|---|---|
| `BOT_TOKEN` | `123456789:ABC_example` | 是 | Telegram Bot Token，Bot API 调用必须使用。 |
| `PANEL_PASSWORD` | `your-strong-password` | 是 | Web 后台登录密码。 |
| `PANEL_SECRET` | `random-long-session-secret` | 是 | Cookie Session 签名密钥，建议使用随机长字符串。 |
| `TELEGRAM_SECRET_TOKEN` | `random-webhook-secret` | 强烈建议 | Telegram Webhook 请求头校验密钥，设置 Webhook 时要填同一个值。 |
| `TURNSTILE_SECRET_KEY` | `0x4AAAAA_secret_example` | 是 | Turnstile 服务端校验密钥。 |
| `FINGERPRINT_HMAC_KEY` | `random-32-byte-or-longer-secret` | 强烈建议 | V2 指纹哈希专用密钥。建议首次启用时生成并长期保持不变；更换后旧指纹参考档案需要重新标记。未配置时功能仍可运行，但会退化为带域隔离的 SHA-256。 |
| `PANEL_USER` | `admin` | 否 | Web 后台用户名，不设置时默认 `admin`。 |

Wrangler Secret 命令示例：

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put PANEL_PASSWORD
npx wrangler secret put PANEL_SECRET
npx wrangler secret put TELEGRAM_SECRET_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put FINGERPRINT_HMAC_KEY
```

### Dashboard 填写位置

Workers 项目：

1. D1 Binding：Worker 项目设置里添加 D1 Database Binding，Binding name 填 `DB`。
2. 普通变量：Worker 项目设置的 Variables 里逐项添加普通变量。
3. Secrets：同一设置页里添加 Secret 类型变量，填入 `BOT_TOKEN`、`PANEL_PASSWORD` 等敏感值。

Pages 项目：

1. D1 Binding：Pages 项目设置里添加 D1 Database Binding，Binding name 填 `DB`。
2. 普通变量：Pages 项目设置的 Environment variables 里添加 Production 变量。
3. Secrets：敏感值只在 Cloudflare Pages 项目设置里填写；如果界面提供 Secret/Encrypted 类型，敏感项选择该类型。

<a id="d1-setup"></a>

## D1 数据库初始化和建表

新部署必须先创建 D1 数据库并执行建表 SQL。空数据库没有基础表时，Bot Webhook、Web 后台、验证页面都会因为找不到表而无法正常运行。

### 需要创建的数据库

| 项目 | 推荐值 | 说明 |
|---|---|---|
| Database name | `tg-dualbot-db` | 可以改名，但 README 和脚本默认使用这个名称。 |
| Binding name | `DB` | 必须是 `DB`，代码固定通过 `env.DB` 访问 D1。 |
| 初始化 SQL | `migrations/0001_initial.sql` | 新库只需要执行这个文件，它已经包含当前版本需要的完整表结构。 |

### Dashboard 手动建库建表

1. Cloudflare Dashboard 进入 `Workers & Pages`。
2. 打开 `D1 SQL Database`，创建数据库，名称建议填 `tg-dualbot-db`。
3. 进入这个 D1 数据库的 Console 或 Query 页面。
4. 打开项目里的 `migrations/0001_initial.sql`，复制全部 SQL。
5. 粘贴到 D1 Console 并执行。
6. 回到 Worker 或 Pages 项目设置，添加 D1 Binding，Binding name 填 `DB`，Database 选择刚创建的数据库。

### Wrangler 命令建库建表

```powershell
npx wrangler d1 create tg-dualbot-db
```

创建成功后，把命令输出里的 `database_id` 填进 `wrangler.toml` 的 `[[d1_databases]]`（**这个值不要提交到公开仓库**，它是账号内部的资源标识；GitHub 自动部署走的是环境变量注入，见「配置项和密钥」）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tg-dualbot-db"
database_id = "你的 D1 database_id"
```

然后执行建表：

```powershell
npm run db:apply
```

### 新库会创建的表

| 表名 | 作用 |
|---|---|
| `users` | Telegram 用户资料、验证状态、封禁状态与原因、静默隔离状态与原因、IP/设备信息、话题绑定信息。 |
| `message_map` | 管理员私聊回复和原用户消息之间的映射。 |
| `inbox_messages` | 用户入站消息、管理员出站消息、Web/话题转发状态。 |
| `spam_keywords` | 私聊广告拦截关键词。 |
| `settings` | 后台保存的管理员 ID、欢迎语、控制模式等设置。 |
| `event_logs` | 系统事件和错误日志。 |
| `rate_events` | 用户消息限频记录。 |
| `broadcasts` | 群发任务：内容、发送范围、目标人数、游标位置、成功与失败计数和任务状态。 |
| `broadcast_recipients` | 每个用户对每个群发任务的送达结果，失败时记 Telegram 返回的错误原因。 |
| `telegram_updates` | 已处理的 Telegram update_id，用于 Webhook 重发去重。 |
| `ip_verifications` | Cloudflare Turnstile、HTTP IP、IPv4/IPv6、UDP WebRTC、ASN、设备记录。 |
| `verification_sessions` | Telegram 用户一次性验证 token 和验证会话。 |
| `webrtc_identity_labels` | 管理员手动标记的 WebRTC 精确哈希和标签；同一哈希全局唯一。 |
| `webrtc_identity_confirmations` | 管理员人工确认后的用户与 WebRTC 标签关联；每个用户最多一行。 |
| `fingerprint_profiles_v2` | 每个用户最多 3 个滚动 V2 指纹档案。 |
| `fingerprint_labels_v2` | 管理员手动建立的观察/指纹黑名单标签；每个来源用户最多 5 个。 |
| `fingerprint_reference_profiles_v2` | 人工确认后的参考锚点；每个标签最多 12 个。 |
| `fingerprint_reference_lookup_v2` | 只为人工锚点建立的有界候选索引；每个锚点最多 14 行。 |
| `fingerprint_user_labels_v2` | 用户与人工确认标签的关联；每个用户最多一行。 |

### 旧库升级

如果你是从旧版数据库升级，不要重复执行 `0001_initial.sql`。按缺少的版本执行：

```powershell
npm run db:upgrade:verification
npm run db:upgrade:topics
npm run db:upgrade:webrtc-identity
npm run db:upgrade:fingerprint-v2
npm run db:upgrade:moderation
npm run db:upgrade:broadcast
```

如果旧库已经运行过新版 Worker，运行时代码可能已经自动补齐字段；这时升级 SQL 遇到重复字段可以停止，不影响新版运行。
`0009_moderation_reason.sql` 只新增封禁与隔离的原因、时间字段和一个索引，运行时也会自动补齐，可以不手工执行。
`0010_broadcast.sql` 建的两张群发表同样会在运行时自动创建，只有在希望先手工建好表时才需要执行。

<a id="cron"></a>

## Cron 触发器

`wrangler.toml` 里的 `[triggers]` 配了一条 `crons = ["* * * * *"]`，用来推进群发任务：每分钟发一批 40 人，批内按 500ms 间隔限速，整批 20 秒发完，稳态约 0.7 条/秒。400 人约 12 分钟发完。

- Cloudflare 只支持 5 段式 cron，不支持带秒的 6 段写法，所以最细粒度就是每分钟。
- 没有进行中的群发任务时，Cron 回调直接返回，不产生任何额外开销。
- **修改 `wrangler.toml` 后必须重新部署一次，Cron 才会生效**；用 Dashboard 手动上传代码的话，在「设置 → 触发器 → Cron Triggers」里手动添加 `* * * * *`，效果与配置文件一致。
- Cron 配置变更需要几分钟才会生效，不是保存即跑。
- 后台页面上的「发送」按钮会立刻发第一批，剩下的交给 Cron，所以关掉浏览器不影响发送。

<a id="workers-manual"></a>

## Workers 手动复制部署

适合不想用 CLI 上传代码的情况。

1. Cloudflare Dashboard 进入 `Workers & Pages`。
2. 创建 Worker。
3. 打开模块编辑器，保持 `worker.js` 和 `fingerprint-v2.js` 位于同一根目录后保存部署；如果当前在线编辑器只能粘贴单个文件，请改用 Workers + GitHub 或 Wrangler 部署，不能只复制 `worker.js`。
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
   - `FINGERPRINT_HMAC_KEY`
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
   - `FINGERPRINT_HMAC_KEY`
10. 在 D1 控制台执行 `migrations/0001_initial.sql`。
11. 重新部署 Pages。
12. 设置 Telegram Webhook。

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
| 全体通知 | `/broadcast` 一次性群发给私聊过 Bot 的用户，可选全部用户或仅已验证用户；由 Cron 每分钟发一批，单条失败不影响其他人。 |
| 广告拦截 | `/rules` 支持维护私聊关键词，命中后可自动封禁并通知管理员。 |
| 刷屏拦截 | 两道自动闸：限流分短窗口（10 秒 4 条）与长窗口（1 小时 30 条），专门拦「每条隔一两分钟、慢慢刷十几个小时」这种躲开短窗口的节奏；同一段文本 1 小时内重复 5 次即判刷屏，直接封禁并通知管理员。阈值走后台设置，可随时调。 |
| Cloudflare 验证记录 | `/verifications` 展示 Turnstile 通过记录、HTTP IP、WebRTC UDP 结果、国家、机房、ASN、User-Agent。 |
| WebRTC 人工身份标签 | 管理员使用现有备注手动标记 WebRTC；后续 WebRTC 精确命中只显示“待人工确认”，点击“确认同一人”后才建立持久标签关联。 |
| V2 设备与网络指纹 | 验证页采集 Canvas、WebGL、Audio、字体、CPU/屏幕、UA-CH、时区语言、Telegram 客户端和 HTTP/WebRTC 网络层；四向量加权比较，覆盖跨浏览器、跨设备、跨平台识别；默认只生成候选，标记与确认都必须由管理员手动完成，自动拉黑需另行开启。 |
| Telegram 话题控制 | `CONTROL_MODE=topic/both` 时，验证通过后可自动创建用户专属群话题，管理员在话题里回复会回到用户。 |
| 多管理员 | `ADMIN_CHAT_IDS` 最多取 3 个管理员 ID，可通过后台设置或 Cloudflare 环境变量配置；话题回复也只允许这些 ID。 |
| 后台登录 | `/login` 使用用户名、密码和 Cookie Session；密码、Bot Token 等敏感值通过 Cloudflare Secrets 保存。 |
| 日志与健康检查 | `/logs` 按类型切页查看运行事件，每条附中文说明与处理建议；`/health` 返回 `ok`。 |

<a id="web-panel"></a>

## Web 面板功能

| 页面 | 路径 | 功能 |
|---|---|---|
| 登录 | `/login` | 输入后台用户名和密码，成功后写入 `tg_dualbot_session` Cookie。 |
| 总览 | `/` | 显示用户总数、已验证、已封禁、已隔离、消息记录、验证通过数，以及控制模式、公开地址和验证入口格式。 |
| 收件箱 | `/inbox` | 显示用户入站消息、管理员出站回复、消息方向、来源（用户私聊 / 话题回复 / 管理员私聊 / Web 后台）、状态和错误；支持回复与重试。 |
| 用户管理 | `/users` | 查看用户资料、备注标签、封禁与静默隔离状态、验证状态、HTTP IP、UDP WebRTC、V2 指纹、ASN、设备系统和话题绑定；操作区为固定 3×3 按钮网格，含封禁 / 解封、静默隔离 / 解除隔离、取消验证、指纹标签、标记指纹、创建话题、重建话题、解绑话题和删除用户。 |
| 名单管理 | `/moderation` | 集中查看封禁名单与静默隔离名单，显示每条记录的原因、时间和当前状态，可直接解除或追加处理；页面顶部说明两种处理方式的区别与原因来源。 |
| 群发通知 | `/broadcast` | 填写一段内容、选择发送范围后群发；Cron 每分钟发一批，页面显示进行中任务的进度，可试发到自己私聊确认排版、取消未完成任务、查看每个失败用户的原因。 |
| 广告拦截 | `/rules` | 一行一个关键词；可开关命中后自动封禁。自动封禁会把命中的关键词写入封禁原因。 |
| CF 验证记录 | `/verifications` | 展示每次 Turnstile 通过后的 IP、UDP/WebRTC、ASN、运营商、地区、设备系统、User-Agent 和时间。 |
| 设置 | `/settings` | 保存管理员 Chat ID、欢迎语、控制模式、话题群与话题策略、指纹识别两个开关；查看公开地址、验证入口和 Secrets 配置状态（区分必填与可选）。 |
| 日志 | `/logs` | 按类型切页查看：全部 / 群发 / 消息转发 / 话题 / 验证与指纹 / 命令 / 系统；窗口内存在未收录的历史日志时另出「其他」。每类独立取最近 100 条并可加载更多，所以一次群发产生的几十条发送失败不会把其他类型挤掉。每条日志都有中文说明与处理建议。 |
| 退出 | `/logout` | 清除后台 Cookie。 |

<a id="moderation"></a>

## 名单管理

`/moderation` 集中管理两类处理名单，并把处理原因和时间一起记录下来。

| 处理方式 | 用户侧感受 | 消息记录 | 适用场景 |
|---|---|---|---|
| 封禁 | 收到「已被加入黑名单」提示 | 历史记录保留，新消息不再转发 | 广告号、骚扰账号 |
| 静默隔离 | 完全无感知，以为消息已发出 | 消息在入口丢弃，不写入记录 | 脚本刷屏号，避免对方换号重来 |

两者可以叠加。隔离在最外层生效，此时封禁提示也不会发出。

原因由执行入口自动写入，无需手工填写：

| 入口 | 写入的原因 |
|---|---|
| 名单管理页按钮 | `名单管理页手动封禁` / `名单管理页手动隔离` |
| 用户管理页按钮 | `Web 用户管理页手动封禁` / `Web 用户管理页手动隔离` |
| Telegram 话题 `/admin` 按钮 | `Telegram 话题按钮拉黑（管理员 <ID>）` / `Telegram 话题按钮隔离（管理员 <ID>）` |
| 验证通知的「拉黑」按钮 | `Telegram 验证通知按钮拉黑（管理员 <ID>）` |
| `/block <用户ID> [原因]` | 命令里的原因文本，未填写时为 `Telegram /block 命令（管理员 <ID>）` |
| 广告关键词自动拉黑 | `广告关键词自动拉黑：<命中的关键词>` |

解除封禁或解除隔离时，对应的原因与时间会一并清空，不会留下过期信息。
升级前已经处于封禁或隔离状态的用户没有原因记录，页面会显示「未记录原因」。

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
- WebRTC 标签命中时显示“确认同一人”按钮；点击前不会建立身份关系。

<a id="cloudflare-verification"></a>

## Cloudflare 验证门禁

验证流程：

```text
用户私聊 Bot
  -> Bot 发现用户未验证
  -> 生成 verification_sessions token
  -> Telegram 返回一个“打开验证界面”Mini App 主按钮
  -> 消息正文同时提供浏览器备用验证链接，二者打开同一 /verify/{token}
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
- UDP/WebRTC 层：浏览器尝试通过两个 STUN 收集候选地址；只有公网 UDP `srflx` 会进入身份判断，`host`、私网和 `relay` 会被排除。

限制说明：

- 单次 HTTP 请求通常只会走 IPv4 或 IPv6 其中一种，因此另一项可能为空。
- HTTP 身份字段只采用 Cloudflare 请求中的 `CF-Connecting-IP`；浏览器提交的 probe 地址不会参与身份判断。
- WebRTC UDP 记录受浏览器、代理、系统隐私设置、企业网络和运营商网络影响，可能显示 `empty`、`unsupported` 或 `failed`。
- 本项目会记录字段和状态，不把空值伪造成真实 IP。

### WebRTC 标签与人工确认

WebRTC 标签采用独立的人工流程：

1. 先通过 `/note <user_id> <标签>` 或 Web 后台给已知用户设置备注，例如 `小孩`。
2. 管理员在验证通知或用户话题中点击“标记 WebRTC”。系统只保存当前 WebRTC 地址计算出的 32 字符 SHA-256 哈希，不在标签表重复保存原始 IP。
3. 后续账号验证时，如果本次 WebRTC 哈希与标签完全一致，通知显示“WebRTC 标签命中（待人工确认）”。
4. 管理员点击“确认同一人”后，才写入该用户的人工确认关联；系统不会自动拉黑或自动确认身份。

资源限制：

- WebRTC 标签继续使用唯一哈希索引；一次验证最多执行 13 个等值索引分支，每支固定 `LIMIT 10`，进入 Worker 合并前最多 130 条候选行，不会扫描整张档案表。
- 自动匹配不会新增标签或确认记录；只有管理员点击标记或确认时才写入 D1。
- 相同 WebRTC 哈希重复标记只更新原记录；每个来源用户最多保留 5 个直接标记。
- 每个已确认用户在 `webrtc_identity_confirmations` 中最多一行，重新确认时覆盖。
- 删除标签会同步删除对应确认关系；完整删除用户会同步清理其标签和确认记录。

WebRTC 精确一致通常表示相同公网 NAT、代理或 VPN 出口，不等于自动证明同一人，因此最终确认必须由管理员完成。WebRTC candidate 来自浏览器提交的客户端数据，Turnstile 不会验证该字段真实性；恶意用户可能伪造，所以人工确认时还应结合 Telegram 账号、历史消息等其他证据。

### V2 设备与网络指纹

V2 在 Turnstile 验证页并行采集设备与网络信号，上传后立即计算 HMAC/SHA-256 派生 key、64 位 SimHash、字体 MinHash/Jaccard 和 10 维数值向量。原始设备采集值不会重复写入 `ip_verifications.raw_client_data`；D1 只保存有界的派生值和少量设备摘要。

#### 采集三层

| 层 | 采集项 |
|---|---|
| 设备层 | Canvas、WebGL、Audio、CPU、Screen、Fonts、device model、performance class |
| 客户端层 | Telegram platform、Telegram version、OS、浏览器引擎、时区、系统语言 |
| 网络层 | 公网 IP / ASN / ISP，以及 WebRTC IP / ASN / ISP |

#### 四向量比较

比较不使用「哪一侧最高就取哪一侧」的最大值融合，而是四个向量加权求和后按档位设下限与上限。这样避免同一个出口网络下的两个陌生人因为网络层满分而被直接判成同一人。

| 向量 | 权重 | 组成 | 换浏览器时 |
|---|---|---|---|
| A · WebRTC 向量 | 30% | IP 15、ASN 5、ISP 15 | 保留 |
| B · 公网 IP 向量 | 20% | IP 12、ASN 6、ISP 7 | 保留 |
| C · 渲染指纹 | 25% | Canvas 10、WebGL 8、Audio 7 | **整体失效** |
| D · 稳定不变量 | 25% | OS 4、CPU 5、屏幕 5、字体 6、时区 4、语言 3、性能等级 2、机型 2 | 保留 |

拆分 C 与 D 的原因：换浏览器后 Canvas/WebGL/Audio 三个哈希全部改变，向量 C 归零；而 OS、CPU 核数、屏幕参数、系统字体、时区、语言读的是同一套系统信息，向量 D 仍然维持高位。因此向量 D 是「同一设备换浏览器」的唯一识别依据。

数值维度使用连续距离而不是布尔相等：IP 按前缀分级（同 IP 1.0、同 /24 0.7、同 /16 0.35），CPU 与屏幕用归一化欧氏距离，字体用 Jaccard 交并比。这样换浏览器导致屏幕缩放或字体探测精度轻微偏移时，仍能得到接近 1 的相似度而不是直接归零。

双方都缺失的维度不参与计分，只从分母中剔除，并通过采集覆盖率反映完整度，既不白送分也不硬扣分。

#### 判定档位

| 档位 | 触发条件 | 分数 | 默认列为候选 |
|---|---|---|---|
| 完整指纹一致 | 算法版本、完整哈希、HTTP key 全同且质量 ≥63% | 100 | 是 |
| WebRTC 与渲染指纹双重一致 | WebRTC IP 一致且渲染指纹三项全同 | ≥98 | 是 |
| WebRTC IP 一致 | WebRTC IP 精确一致 | ≥92 | 是 |
| WebRTC IP 一致但设备层偏低 | WebRTC IP 一致但渲染与稳定不变量都很低 | ≥92 | 是（附风险提示） |
| 公网 IP、ASN、ISP 全部一致 | WebRTC 未采集到，公网三项全同 | ≥90 | 是 |
| 渲染指纹三项一致 | Canvas、WebGL、Audio 全同 | ≥90 | 是 |
| 稳定不变量一致且网络层支撑 | 稳定不变量 ≥85% 且网络层 ≥50% | ≥82 | 是 |
| 稳定不变量一致但网络层无交集 | 只剩稳定不变量一致 | 62~74 | **否**，需开启规则 6 |
| 仅网络相近 | 网络接近但设备层证据不足 | ≤55 | 否 |

跨浏览器、跨设备、跨平台的识别都由上表覆盖：同网络换浏览器走「WebRTC IP 一致」或「稳定不变量一致且网络层支撑」；同网络换设备或换平台走「WebRTC IP 一致」；同设备换网络走「渲染指纹三项一致」。

同时换设备又换网络时没有任何共同信号，任何浏览器指纹方案都无法识别，本项目也不做猜测。

#### 两个开关（默认关闭）

关闭状态下的行为与升级前完全一致：指纹只生成人工候选，绝不自动封禁。

| 设置项 | 默认 | 说明 |
|---|---|---|
| 启用弱证据档（规则 6） | 关 | 开启后「稳定不变量一致但网络层无交集」也会列为候选。代价是同型号的另一台设备与真正的同设备换浏览器换网络在信号层面完全相同，两者会一起进入这一档。 |
| 启用指纹自动拉黑 | 关 | 仅当命中标签状态为「指纹黑名单」且分数达到阈值时自动封禁。命中「观察标签」永不自动处理。 |
| 自动拉黑最低分数 | 95 | 取值范围 60~100。 |

两个开关也可以通过环境变量 `FP_WEAK_SUSPECT_ENABLED` 与 `FP_AUTO_BLOCK_ENABLED` 预设，后台设置页保存的值优先。

#### 手动标签工作流

1. 用户来捣乱，管理员先用 `/note <user_id> <标签>` 或 Web 后台设置备注，例如 `小孩哥`。
2. 在该用户话题中点击「标记指纹」，系统以当前备注建立标签，并把当前指纹存为参考锚点。用户此时已被封禁则标签状态为「指纹黑名单」，否则为「观察标签」。
3. 该用户换小号再来，验证通过后系统自动与全部锚点比对，命中后在话题与管理员通知里显示四向量证据卡片。
4. 管理员点击「确认同一人」写入人工确认关联，或点击「确认并拉黑」一步完成确认与封禁，封禁原因自动写入标签名与分数。

#### D1 固定边界

- 每个用户最多 3 个滚动档案；同一档案重复验证只增加次数并更新时间。
- 每个来源用户最多 5 个直接标签；每个标签最多 12 个已确认参考锚点。
- 每个锚点最多 14 条小型 lookup；普通验证不会创建全局 lookup。
- 每次先执行 1 个 exact 等值查询；未命中时最多批量执行 13 个等值索引分支。每个分支都有硬 `LIMIT`，最坏最多读取 140 条小型 lookup 行，再去重截取 24 个参考候选并按标签保留前 5 个提示。
- 标签和锚点使用原子限额写入；重复操作不会突破 5/12 上限。

`FINGERPRINT_HMAC_KEY` 建议使用至少 32 字节随机密钥并长期保持不变。更换该密钥后，旧锚点的 HMAC lookup 无法再与新验证匹配，需要删除或重新标记相关 V2 标签。

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

按钮包括通过验证、取消验证、拉黑、取消拉黑、静默隔离、解除隔离、获取用户信息、重建话题、标记 WebRTC、查看 WebRTC 标签、标记指纹和查看指纹标签。

指纹或 WebRTC 命中后的验证通知会额外显示确认按钮：

- WebRTC 精确命中显示「确认同一人（WebRTC）」。
- 指纹命中确认档（完整一致、WebRTC 一致、渲染指纹一致、稳定不变量加网络支撑）时显示「确认同一人」与「确认并拉黑」两个按钮。
- 指纹命中弱证据档（仅稳定不变量一致）时只显示「确认同一人」，不提供一步拉黑。
- 已经被自动拉黑的用户不再重复显示拉黑按钮。

Web 后台的用户管理页继续提供创建话题、重建话题、解绑话题、静默隔离和删除用户操作；名单管理页可查看封禁与隔离原因并直接解除。

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
| `/users/{user_id}/block` | POST | 封禁用户，并记录封禁原因与时间。 |
| `/users/{user_id}/unblock` | POST | 解封用户，同时清空封禁原因与时间。 |
| `/users/{user_id}/mute` | POST | 开启静默隔离，并记录隔离原因与时间。 |
| `/users/{user_id}/unmute` | POST | 解除静默隔离，同时清空隔离原因与时间。 |
| `/users/{user_id}/unverify` | POST | 取消用户验证状态。 |
| `/users/{user_id}/fingerprints` | GET | 查看该用户的 V2 指纹与标签。 |
| `/users/{user_id}/fingerprints/mark` | POST | 用当前备注把当前指纹标记为参考锚点。 |
| `/fingerprint-labels/{id}/delete` | POST | 删除指纹标签及其全部参考档案。 |
| `/users/{user_id}/topic/create` | POST | 为用户创建 Telegram 专属话题。 |
| `/users/{user_id}/topic/rebuild` | POST | 强制重建用户专属话题。 |
| `/users/{user_id}/topic/unbind` | POST | 解除用户和话题的绑定，不删除用户记录或 Telegram 话题。 |
| `/users/{user_id}/delete` | POST | 删除用户及其消息、验证、验证会话、限频和回复映射数据；不删除 Telegram 话题。 |
| `/moderation` | GET | 名单管理：封禁名单、静默隔离名单、原因说明与两种处理方式的区别。 |
| `/moderation/{user_id}/block` | POST | 从名单页封禁用户。 |
| `/moderation/{user_id}/unblock` | POST | 从名单页解除封禁。 |
| `/moderation/{user_id}/mute` | POST | 从名单页开启静默隔离。 |
| `/moderation/{user_id}/unmute` | POST | 从名单页解除静默隔离。 |
| `/broadcast` | GET | 群发通知：发送表单、进行中任务的进度和群发记录。 |
| `/broadcast` | POST | 创建群发任务并立刻发第一批，剩余批次交给 Cron。 |
| `/broadcast/preview` | POST | 用同一份内容先发一条到自己的私聊，不创建群发任务。 |
| `/broadcast/cancel` | POST | 取消进行中的群发任务；已发出的消息无法撤回。 |
| `/rules` | GET/POST | 查看和保存广告关键词。 |
| `/verifications` | GET | CF 验证记录。 |
| `/settings` | GET/POST | 后台设置。 |
| `/logs` | GET | 运行日志。 |

<a id="database"></a>

## 数据表

| 表 | 作用 |
|---|---|
| `users` | Telegram 用户资料、备注、封禁状态与原因、静默隔离状态与原因、验证状态、最近 HTTP/UDP/IP/ASN/设备信息和话题绑定信息。 |
| `verification_sessions` | 一次性验证 token、过期时间、验证状态和本次采集到的网络信息。 |
| `ip_verifications` | 每次 Turnstile 通过后的验证记录。 |
| `webrtc_identity_labels` | 管理员手动标记的 WebRTC 哈希、标签、来源用户和创建人。 |
| `webrtc_identity_confirmations` | 每个用户当前由管理员确认的 WebRTC 标签关联。 |
| `inbox_messages` | 入站消息、出站回复、消息类型、Web/话题转发状态、错误信息和话题消息元数据。 |
| `message_map` | 管理员 Telegram 消息 ID 到用户消息的映射，用于回复定位。 |
| `spam_keywords` | 广告关键词。 |
| `settings` | 管理员 Chat ID、欢迎语等后台设置。 |
| `event_logs` | 运行事件。 |
| `rate_events` | 用户发送频率记录。 |
| `broadcasts` | 群发任务：内容、发送范围、目标人数、游标位置、成功与失败计数和任务状态。 |
| `broadcast_recipients` | 每个群发任务对每个用户的送达结果，成功时记 message_id，失败时记 Telegram 返回的错误原因。 |
| `telegram_updates` | 已处理的 Telegram update_id，用于 Webhook 重发去重。 |
| `fingerprint_profiles_v2` | 每用户最多 3 个滚动 V2 指纹档案。 |
| `fingerprint_labels_v2` | 管理员建立的指纹标签及其状态（观察 / 指纹黑名单）。 |
| `fingerprint_reference_profiles_v2` | 每个标签最多 12 个已确认的参考指纹锚点。 |
| `fingerprint_reference_lookup_v2` | 指纹倒排索引（精确哈希、WebRTC、HTTP、SimHash 分桶、字体 MinHash 分桶）。 |
| `fingerprint_user_labels_v2` | 每个用户当前由管理员确认的指纹标签及匹配依据。 |

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
│  ├─ npm run db:upgrade:webrtc-identity：旧库新增 WebRTC 标签与人工确认表。
│  ├─ npm run db:upgrade:fingerprint-v2：旧库新增 V2 指纹五张表。
│  ├─ npm run db:upgrade:moderation：旧库补封禁与静默隔离的原因、时间字段。
│  ├─ npm run db:upgrade:broadcast：旧库新建群发任务与逐人结果两张表。
│  ├─ npm run test:fingerprint：运行 V2 算法和 D1 有界性测试。
│  ├─ npm run test:verification-client：渲染并检查验证页内嵌采集脚本。
│  ├─ npm run test:broadcast：运行群发的口径、限速、游标推进和失败处理测试。
│  ├─ npm run test:topic-isolation：运行话题归属、Webhook 幂等与静默隔离测试。
│  ├─ npm run test:antispam：运行限流双档与重复内容刷屏拦截测试。
│  ├─ npm run test:log-translation：运行日志翻译、来源标注与分类切页测试。
│  └─ npm run pages:deploy：Pages Direct Upload。
├─ wrangler.toml
│  ├─ name：Worker 名称。
│  ├─ main = "worker.js"：Workers 入口。
│  ├─ [[d1_databases]]：D1 绑定，binding 必须是 DB。
│  ├─ [triggers]：Cron 表达式，每分钟推进一批群发任务，改了要重新部署才生效。
│  └─ 不写 [vars]：普通变量全部在 Cloudflare Dashboard 的「设置 → 变量和机密」里维护。
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
│  ├─ scheduled() 和 runPendingBroadcastBatch()：Cron 推进群发任务，每分钟发一批。
│  └─ tgCall()、D1 helper、Cookie helper、日志 helper。
├─ fingerprint-v2.js
│  └─ V2 HMAC、SimHash、MinHash/Jaccard、Gower、35/25/40 评分和有界 lookup 生成。
├─ functions/
│  └─ [[path]].js
│     └─ Pages Functions catch-all 入口，导入 ../worker.js 并调用 handleRequest()。
├─ public/
│  └─ .keep
│     └─ Pages 静态输出目录占位文件。
├─ migrations/
│  ├─ 0001_initial.sql
│  │  └─ 新部署完整 D1 表结构。
│  ├─ 0002_verification_gate.sql
│  │  └─ 旧数据库升级到验证门禁版本。
│  ├─ 0003_topic_mode.sql
│  │  └─ 旧数据库升级到 Telegram 话题双通道版本。
│  ├─ 0005_webrtc_identity.sql
│  │  └─ 旧数据库新增 WebRTC 标签与人工确认表。
│  ├─ 0007_fingerprint_v2.sql
│  │  └─ 旧数据库新增 V2 指纹五张表和索引。
│  ├─ 0008_inbound_isolation.sql
│  │  └─ 旧数据库新增静默隔离字段与 Telegram Webhook 幂等表。
│  ├─ 0009_moderation_reason.sql
│  │  └─ 旧数据库新增封禁与静默隔离的原因、时间字段和封禁索引。
│  └─ 0010_broadcast.sql
│     └─ 新增群发任务表和逐人送达结果表。
├─ tests/
│  ├─ broadcast.test.mjs
│  ├─ fingerprint_v2_algorithm.test.mjs
│  ├─ fingerprint_v2_schema.test.mjs
│  ├─ log_translation.test.mjs
│  ├─ topic_isolation.test.mjs
│  └─ verification_client_script.test.mjs
└─ README.md
   └─ 功能、部署、配置、验证和排错说明。
```

<a id="config"></a>

## 配置项和密钥

### 普通变量（在 Dashboard 配置）

这些变量不写进 `wrangler.toml`，全部在 Cloudflare Dashboard 的「设置 → 变量和机密」里维护。

| 名称 | 示例 | 说明 |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://tg-dualbot-cloudflare.example.workers.dev` | 机器人生成验证链接、设置 Webhook 时使用的公开地址，正式部署必须填写。 |
| `TURNSTILE_SITE_KEY` | `0x4AAAAA_example` | 前端 Turnstile Widget 使用。 |
| `CONTROL_MODE` | `both` | 控制通道：`web`、`topic`、`both`。 |
| `TOPIC_GROUP_ID` | `-1001234567890` | 话题群 ID。 |
| `TOPIC_CREATE_POLICY` | `after_verify` | 话题创建策略。 |
| `TOPIC_SYNC_WEB_REPLIES` | `true` | 是否把 Web 后台和管理员私聊回复同步到用户话题。 |
| `FP_WEAK_SUSPECT_ENABLED` | `false` | 指纹弱证据档开关，默认关闭。 |
| `FP_AUTO_BLOCK_ENABLED` | `false` | 指纹自动拉黑开关，默认关闭。 |
| `FP_AUTO_BLOCK_MIN_SCORE` | `95` | 自动拉黑最低分数，60~100。 |
| `ADMIN_CHAT_IDS` | `123456789,987654321` | 管理员 Chat ID，可后续在后台设置页保存。 |

### Cloudflare Secrets

| 名称 | 说明 |
|---|---|
| `BOT_TOKEN` | Telegram Bot Token。 |
| `PANEL_PASSWORD` | Web 后台登录密码。 |
| `PANEL_SECRET` | Cookie Session 签名密钥，建议使用随机长字符串。 |
| `TELEGRAM_SECRET_TOKEN` | Telegram Webhook 请求头校验密钥。 |
| `TURNSTILE_SECRET_KEY` | Turnstile 服务端 `siteverify` 使用。 |
| `FINGERPRINT_HMAC_KEY` | V2 指纹专用 HMAC 密钥；建议至少 32 字节并长期保持不变。 |
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

把输出里的 `database_id` 填到 `wrangler.toml`（**这个值不要提交到公开仓库**）：

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
5. 复制 Site Key 到 Dashboard 的 `TURNSTILE_SITE_KEY` 变量（Worker → 设置 → 变量和机密）。
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
name = "tc044"
main = "worker.js"
compatibility_date = "2026-07-08"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "tg-dualbot-db"
database_id = "你的 D1 database_id"
```

`name` 要和 Dashboard 上实际的 Worker 名一致。变量不要写进 `[vars]`，去 Dashboard 的「设置 → 变量和机密」填。

`database_id` 直接写进 `wrangler.toml`。它只是资源编号，拿到也调不了任何 API —— 能调用账号的凭据是 Token / Global API Key，那些只放在 Dashboard 的 Secrets 里，不进仓库。写死还有一个原因：早先是靠构建命令里的 `sed` 从环境变量注入的，那条命令一旦在 Dashboard 上丢了，`REPLACE_WITH_D1_DATABASE_ID` 这个占位符就会原样进部署请求，报 `10021 binding DB of type d1 must have a valid database_id specified` 构建失败。写在文件里，部署路径就只剩 `npx wrangler deploy` 一步，不再有第二个环节可以丢。

本地部署同理，不需要额外设置环境变量，`npx wrangler deploy` 直接用文件里的值。

2. 写入 Secrets：

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put PANEL_PASSWORD
npx wrangler secret put PANEL_SECRET
npx wrangler secret put TELEGRAM_SECRET_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put FINGERPRINT_HMAC_KEY
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

<a id="pages-upload"></a>

## Pages Direct Upload 部署

本方式使用 Wrangler 上传 `public` 静态目录，同时带上 `functions` 目录中的 Pages Functions。

```powershell
npm run pages:deploy
```

部署后仍要在 Cloudflare Pages 项目设置里配置：

- D1 Binding：`DB`。
- 普通变量：`PUBLIC_BASE_URL`、`TURNSTILE_SITE_KEY`、`ADMIN_CHAT_IDS`、`CONTROL_MODE`、`TOPIC_GROUP_ID`、`TOPIC_CREATE_POLICY`、`TOPIC_SYNC_WEB_REPLIES`。
- Secrets：`BOT_TOKEN`、`PANEL_PASSWORD`、`PANEL_SECRET`、`TELEGRAM_SECRET_TOKEN`、`TURNSTILE_SECRET_KEY`、`FINGERPRINT_HMAC_KEY`。

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

### Telegram Mini App 验证

验证提示默认优先使用 Telegram Mini App，并保留普通浏览器备用入口：

- `打开验证界面`：唯一主按钮，使用 Bot API 的 `web_app` 在 Telegram 内打开验证页。
- `浏览器备用验证`：显示在消息正文中的链接，仅在 Mini App 无法打开时使用。

主按钮和备用链接使用同一个一次性验证 token，验证结果、D1 记录和管理员通知完全一致。`PUBLIC_BASE_URL` 必须是可公开访问的 HTTPS 地址，并且该域名需要加入 Turnstile Widget 的允许主机名。

Mini App 按钮仅适用于 Bot 与用户的私聊；本项目的验证提示只在私聊中发送，因此不会影响群话题和管理员控制功能。

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
2. Bot 显示一个“打开验证界面”Mini App 主按钮。
3. 点击主按钮并完成 Turnstile。
4. 再确认消息正文中的“浏览器备用验证”链接也能打开同一验证页。
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

如果旧库还没有 WebRTC 标签与人工确认表，可以执行：

```powershell
npm run db:upgrade:webrtc-identity
```

`0005` 不执行删除操作，只使用外键开关和 `CREATE TABLE/INDEX IF NOT EXISTS`，可以安全重复执行。新版 Worker 也会在首次相关请求时自动补齐这些表和索引，因此不会清空已有用户、黑名单、验证状态或 WebRTC 标签。

如果旧库还没有 V2 指纹五张表，可以执行：

```powershell
npm run db:upgrade:fingerprint-v2
```

`0007` 只使用 `CREATE TABLE/INDEX IF NOT EXISTS`，不会删除或重置已有用户、黑名单、验证状态、WebRTC 标签和消息。已经部署过并拥有 D1 的项目只执行这条升级命令，不要重新执行 `0001_initial.sql`。

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
- 普通变量和敏感值都放 Cloudflare Dashboard，`wrangler.toml` 不写 `[vars]`，避免部署时把线上配置覆盖成空值。
- `PANEL_SECRET` 建议使用随机长字符串。
- D1 Binding 名称必须是 `DB`，不要改成其他名称。
- `TELEGRAM_SECRET_TOKEN` 建议使用随机字符串，并在设置 Webhook 时同步传入。
- 使用话题模式时，`TOPIC_GROUP_ID` 必须是开启 Topics/Forum 的超级群 ID，且 Bot 需要创建话题和发送消息权限。
- Turnstile Widget 的 Hostname 要包含 Workers、Pages 或自定义域名。
- 管理员 Chat ID 示例可用 `123456789`，正式部署要换成真实管理员 ID。
