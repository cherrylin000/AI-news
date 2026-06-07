# 每日AI洞察 - JavaScript脚本使用说明

## 快速开始

```bash
cd scripts
npm install          # nodemailer 用于 --send-newsletter / --legacy-smtp
```

## 环境变量配置

在项目根目录（`AI news/.env`，与 `scripts/` 同级）复制 `.env.example` 为 `.env` 并填写密钥。脚本启动时会**自动读取**该文件。

也可在终端手动导出环境变量：

```bash
# LLM（生成洞察，必填）
export LLM_API_URL=https://api.openai.com/v1/chat/completions
export LLM_API_KEY=sk-xxxx
export LLM_MODEL=deepseek-v4-flash

# 站点（可选，默认 https://cherrylin000.github.io/AI-news）
export SITE_URL=https://cherrylin000.github.io/AI-news

# Brevo SMTP（可选；用于自动发送完整邮件正文）
export SMTP_HOST=smtp-relay.brevo.com
export SMTP_PORT=587
export SMTP_USER=your-brevo-smtp-login
export SMTP_PASS=your-brevo-smtp-key
export SMTP_FROM=verified-sender@example.com
export SMTP_FROM_NAME=AI洞察日报
export NEWSLETTER_RECIPIENTS='Alice <alice@example.com>, bob@example.com'
```

## 使用方式

```bash
# 默认：拉取 → 生成 → 发布 docs/（不发 SMTP）
node daily-insights.js

node daily-insights.js --fetch-only
node daily-insights.js --generate-only   # 含发布 docs/
node daily-insights.js --send-only         # 从 outputs 加载并发布 docs/
node daily-insights.js --send-newsletter   # 额外 SMTP 群发（需配置 NEWSLETTER_RECIPIENTS）
node daily-insights.js --legacy-smtp       # 兼容旧参数，等同于 --send-newsletter
node daily-insights.js --dry-run
```

npm scripts：`start` / `fetch` / `generate` / `send` / `dry-run` / `legacy-smtp`

## 站点输出

| 路径 | 说明 |
|------|------|
| `../index.html` | 首页：脚本只更新标记内动态区；订阅区人工维护（Pages 选根目录 `/`） |
| `../docs/latest.html` | 当日邮件 HTML |
| `../docs/feed.xml` | RSS Feed |
| `../docs/archive/YYYY-MM-DD.html` | 历史归档 |

## 调整收件人（--send-newsletter）

设置 `NEWSLETTER_RECIPIENTS` 环境变量或 GitHub Secret。支持以下格式：

```text
alice@example.com,bob@example.com
Alice <alice@example.com>; Bob <bob@example.com>
[
  {"name":"Alice","email":"alice@example.com"},
  {"name":"Bob","address":"bob@example.com"}
]
```

## 其他可调配置

在 `CONFIG` 对象中可修改：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `filter.minLikes` | X推文最低点赞数 | 50 |
| `filter.maxInsights` | 最大洞察条数 | 8 |
| `filter.minInsights` | 最小洞察条数 | 5 |
| `sendInterval` | 邮件发送间隔(ms) | 5000 |
| `outputBaseDir` | 输出目录 | `../outputs/每日洞察` |

## 输出文件

每次运行会在 `outputs/每日洞察/YYYY/MM/` 下生成：

| 文件 | 说明 |
|------|------|
| `YYYY-MM-DD_raw_feeds.json` | 原始feed数据 |
| `YYYY-MM-DD_insights.json` | AI生成的洞察结构化数据 |
| `YYYY-MM-DD_标题.md` | Markdown附件 |
| `YYYY-MM-DD_email.html` | HTML邮件正文 |

## 无SMTP时的替代方案

如果暂时没有SMTP服务器，可以：
1. 用 `--dry-run` 或 `--generate-only` 生成文件
2. HTML和MD文件已保存，可手动发送或通过其他工具推送
3. 配置 Brevo SMTP 后用 `--send-newsletter` 自动群发完整正文
