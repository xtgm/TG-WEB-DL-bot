# TG DualBot Cloudflare

Cloudflare Workers + D1 版本的 Telegram 双向机器人后台。

项目定位：把 Telegram Bot 的私聊消息接入 Cloudflare Worker，通过 Webhook 实现用户和管理员之间的双向消息转发，并提供一个 Web 后台用于查看消息、回复用户、管理用户、维护拦截规则和查看 Cloudflare 验证 IP。

## 功能说明

- Telegram 用户私聊 Bot 后，消息自动转发给管理员。
- 管理员在 Telegram 里回复 Bot 转发的消息，Bot 自动回给原用户。
- Web 后台收件箱可查看入站消息、出站回复、转发状态和错误信息。
- Web 后台可直接回复用户。
- 用户管理支持备注、封禁、解封，并显示最近一次 Cloudflare 验证 IP。
- 私聊广告词拦截，命中后可自动封禁并通知管理员。
- 支持最多 3 个管理员 Chat ID。
- 转发失败的入站消息可在收件箱手动重试。
- Cloudflare Turnstile 验证页 `/verify`，验证通过后显示访问者 IP，并写入后台验证记录。
- 后台日志和 `/health` 健康检查。

## 部署后会用到的 Cloudflare 服务

| 服务 | 作用 |
|---|---|
| Cloudflare Workers | 运行 Telegram Webhook、Web 后台和验证页 |
| Cloudflare D1 | 保存用户、消息、映射关系、广告词、设置、日志、验证记录 |
| Cloudflare Turnstile | 提供 CF 验证，验证通过后显示并记录访问 IP |
| Cloudflare Secrets | 保存 Bot Token、后台密码、Webhook Secret、Turnstile Secret 等敏感信息 |
| workers.dev 或自定义域名 | 作为后台和 Telegram Webhook 的公网 HTTPS 地址 |

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
6. Hostname 添加你的 Worker 域名或自定义域名。
   - 如果先用 workers.dev，可以部署后再回到这里补域名。
   - 如果已有自定义域名，可以直接填自定义域名。
7. 创建后记录两个值：
   - `Site Key`：写入 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`。
   - `Secret Key`：写入 Cloudflare Secret `TURNSTILE_SECRET_KEY`。

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
src
migrations
```

## 第 2 步：安装依赖

```powershell
npm install
```

这会安装 Wrangler，用于创建 D1、写入 Secrets 和部署 Worker。

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

## 第 8 步：本地语法检查

```powershell
npm run check
```

等价于：

```powershell
node --check src\worker.js
```

如果没有输出错误，说明 Worker 语法正常。

## 第 9 步：部署 Worker

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

## 第 10 步：配置自定义域名，可选

如果你只使用 workers.dev，可以跳过此步。

如果要绑定自己的域名，例如 `bot.example.com`：

1. 确认域名已经接入 Cloudflare。
2. 进入 Cloudflare Dashboard。
3. 打开 Workers & Pages。
4. 找到 `tg-dualbot-cloudflare` Worker。
5. 进入 `Settings` -> `Triggers`。
6. 添加 `Custom Domain`。
7. 填入 `bot.example.com`。
8. 保存后等待证书生效。
9. 把 `wrangler.toml` 里的 `PUBLIC_BASE_URL` 改成：

```toml
PUBLIC_BASE_URL = "https://bot.example.com"
```

10. 重新部署：

```powershell
npx wrangler deploy
```

同时回到 Turnstile Widget，把 `bot.example.com` 添加到允许的 Hostname。

## 第 11 步：设置 Telegram Webhook

准备三个值：

```powershell
$BOT_TOKEN = "你的 Bot Token"
$PUBLIC_BASE_URL = "https://你的 Worker 地址或自定义域名"
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

如果 `last_error_message` 不为空，说明 Telegram 调用 Worker 失败，需要检查 Worker 地址、Secret Token、部署状态或 Cloudflare 日志。

## 第 12 步：打开后台并完成初始化

打开：

```text
https://你的 Worker 地址/
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

## 第 15 步：验证 Cloudflare Turnstile 和 IP 显示

### 普通验证页

打开：

```text
https://你的 Worker 地址/verify
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
https://你的 Worker 地址/verify?user_id=123456789
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

## 常见问题

### 1. 后台打不开

检查：

- `npx wrangler deploy` 是否成功。
- Worker 地址是否正确。
- 自定义域名证书是否生效。
- Cloudflare Dashboard 里 Worker 是否有报错。

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
- Worker 是否能访问 Telegram API。
- 管理员 Chat ID 是否配置。

### 4. 管理员回复没有回到用户

管理员必须“回复 Bot 转发出来的那条用户消息”或它上方的用户消息 copy。系统依靠 `message_map` 表记录管理员消息 ID 和用户 ID 的对应关系。

如果普通发一条管理员消息，系统不会自动转发。

### 5. Turnstile 显示失败

检查：

- `TURNSTILE_SITE_KEY` 是否写在 `wrangler.toml`。
- `TURNSTILE_SECRET_KEY` 是否用 Wrangler Secret 写入。
- Turnstile Widget 的 Hostname 是否包含当前 Worker 域名或自定义域名。
- 浏览器是否能访问 `https://challenges.cloudflare.com`。

### 6. 验证通过但用户管理页没显示 IP

检查验证链接是否带了 `user_id`：

```text
/verify?user_id=123456789
```

如果只是访问 `/verify`，后台会记录 IP，但不会关联到 Telegram 用户。

### 7. PUBLIC_BASE_URL 留空会怎样

后台仍可打开，Telegram webhook 也可以手动设置，但 Bot 生成 `/verify` 专属链接时会失败。所以正式部署必须配置 `PUBLIC_BASE_URL`。

## 文件结构

```text
tg-dualbot-cloudflare/
  package.json
  wrangler.toml
  README.md
  migrations/
    0001_initial.sql
  src/
    worker.js
```

## 本地检查

```powershell
npm run check
```

## 安全建议

- `BOT_TOKEN`、`PANEL_PASSWORD`、`PANEL_SECRET`、`TELEGRAM_SECRET_TOKEN`、`TURNSTILE_SECRET_KEY` 必须放在 Cloudflare Secrets，不要写进 Git。
- 后台密码使用强密码。
- `PANEL_SECRET` 使用长随机字符串。
- 如果换了域名，记得同步更新 `PUBLIC_BASE_URL`、Turnstile Hostname 和 Telegram Webhook。
- 定期查看 `npx wrangler tail` 和后台日志。