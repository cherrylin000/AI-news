# 每日AI洞察 - JavaScript脚本使用说明

## 快速开始

```bash
cd 长期计划/信息分析洞察计划/scripts
npm install          # 安装依赖（仅需nodemailer）
```

## 环境变量配置

创建 `.env` 文件或直接设置环境变量：

```bash
# SMTP邮件发送（必填，用于发送邮件）
export SMTP_HOST=smtp.example.com
export SMTP_PORT=465
export SMTP_USER=your@email.com
export SMTP_PASS=your-password
export SMTP_FROM=your@email.com        # 可选，默认同SMTP_USER

# LLM API（必填，用于AI洞察生成）
export LLM_API_URL=https://api.openai.com/v1/chat/completions
export LLM_API_KEY=sk-xxxx
export LLM_MODEL=gpt-4o               # 可选，默认gpt-4o
```

## 使用方式

```bash
# 完整流程：拉取feed → AI生成洞察 → 生成MD/HTML → 发送邮件
node daily-insights.js

# 仅拉取feed数据（不生成洞察、不发送邮件）
node daily-insights.js --fetch-only

# 仅生成洞察（从已保存的feed数据，不发送邮件）
node daily-insights.js --generate-only

# 仅发送邮件（从已生成的HTML/MD文件）
node daily-insights.js --send-only

# 完整流程但不实际发送邮件（dry run）
node daily-insights.js --dry-run
```

也可以用npm scripts：

```bash
npm start       # 完整流程
npm run fetch   # 仅拉取
npm run generate # 仅生成
npm run send    # 仅发送
npm run dry-run # 试运行
```

## 调整收件人

编辑 `daily-insights.js` 顶部的 `CONFIG.recipients` 数组：

```javascript
recipients: [
  { name: '车厘子桑', address: 'lhy960423@outlook.com' },
  { name: 'Frank Zhu', address: 'frank.zhu@kln.com' },
  // 新增收件人：
  // { name: '新同事', address: 'new@example.com' },
  // 删除不想发的直接注释或删掉对应行即可
],
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
3. 未来可对接Coze API通过agent邮件能力发送
