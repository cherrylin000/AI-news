# Buttondown 邮件推送配置指南

用 Buttondown 管理订阅者，用 GitHub Actions 每日把 `latest.html` 完整正文推送给所有订阅者。

---

## 第 1 步：注册 Buttondown

1. 打开 <https://buttondown.com>，用邮箱注册（无需手机号）。
2. 创建 Newsletter，名称建议：**AI洞察日报**。
3. 记下你的 **用户名**（URL 里 `buttondown.com/你的用户名` 那段）。

---

## 第 2 步：创建 API Key

1. 登录 Buttondown → **Settings** → **API**（或 **API requests**）。
2. 点击 **Create API key**，权限选能创建/发送邮件即可。
3. 复制密钥（只显示一次），形如一长串 token。

**本地**：写入项目根目录 `.env`：

```env
BUTTONDOWN_API_KEY=你的密钥
BUTTONDOWN_MODE=draft
```

先用 `draft` 测试，确认无误后改为 `send`。

**云端**：GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret 名称 | 值 |
|-------------|-----|
| `BUTTONDOWN_API_KEY` | 你的 API 密钥 |

（`LLM_*` 等原有 Secrets 保持不变。）

---

## 第 3 步：首页订阅表单

编辑根目录 **`index.html`**，找到订阅区，把 `YOUR_BUTTONDOWN_USERNAME` 换成你的用户名（共 2 处：说明文字 + form 的 `action` URL）。

表单地址格式：

```text
https://buttondown.com/api/emails/embed-subscribe/你的用户名
```

保存后提交到 GitHub，等 Pages 更新后，在首页试订阅自己的邮箱。

---

## 第 4 步：本地测试（先草稿，再真发）

```powershell
cd "c:\Users\linhy\Documents\1. Projects\9. Github Projects\AI news\scripts"
npm install
```

**只生成站点、不发邮件：**

```powershell
node daily-insights.js --generate-only
```

**创建 Buttondown 草稿（不发给订阅者）：**

```powershell
node daily-insights.js --buttondown-draft
```

然后去 Buttondown 后台 **Emails** 查看草稿，确认排版与 `docs/latest.html` 一致。

**真发给所有订阅者：**

```powershell
node daily-insights.js --send-buttondown
```

同一天重复运行会自动跳过（防重复发送）。若要强制再发：

```powershell
node daily-insights.js --send-buttondown --force-buttondown
```

---

## 第 5 步：GitHub Actions 自动推送

工作流已配置为每日生成后执行 `--send-buttondown`。

1. 确认已添加 Secret：`BUTTONDOWN_API_KEY`。
2. 打开 **Actions** → **Daily AI Insights** → **Run workflow** 手动试跑。
3. 日志里应出现 `✅ 已提交发送（about_to_send）`。
4. 检查邮箱是否收到**完整 HTML 正文**（不是 follow.it 那种 Click to read）。

定时：每天北京时间 **6:17**（与 workflow 中 cron 一致）。

---

## 第 6 步：验证清单

- [ ] 首页订阅表单能成功订阅（收到 Buttondown 确认邮件）
- [ ] `--buttondown-draft` 能在后台看到草稿
- [ ] `--send-buttondown` 后订阅者收到完整正文
- [ ] 可访问 Buttondown 归档页查看历史邮件

---

## 对齐与样式说明

Buttondown API 已不再接受创建邮件时的 `template` 字段（会返回 `422 extra_forbidden`）。请在 Newsletter 后台固定模板：

Buttondown → **Settings → Email → Template** → 选 **Naked**

- **Modern**（Buttondown 默认）：会套一层主题外壳，正文常被强制**左对齐**，你在 HTML 里写 `text-align:center` 可能无效。
- **Naked**：只发送我们自己的完整 HTML，居中/字体由 `daily-insights.js` 控制，**一般不必在后台再调对齐**。

环境变量 `BUTTONDOWN_TEMPLATE` 仍用于脚本本地正文处理（如是否插入 `buttondown-editor-mode` 注释），但**不会**再写入 API 请求。

---

## 常见问题

**Q：和 follow.it 的关系？**  
可停用 follow.it。RSS（`docs/feed.xml`）仍可保留给 RSS 阅读器，不再用于邮件群发。

**Q：免费版限制？**  
前 **100** 位活跃订阅者免费；API 发信免费。RSS-to-email 自动化是付费附加项，我们用的是 **API 推送**，不需要该附加项。

**Q：发信失败？**  
- 检查 API Key 是否正确、是否写入 Secrets  
- 新账号有时需先在 Buttondown 后台手动发一封测试邮件  
- 查看 Actions 日志里的 `Buttondown API 4xx` 错误详情

**Q：想改发信时间？**  
改 `.github/workflows/daily-insights.yml` 里的 `cron` 即可。

---

## 环境变量一览

| 变量 | 必填 | 说明 |
|------|------|------|
| `BUTTONDOWN_API_KEY` | 发信时必填 | API 密钥 |
| `BUTTONDOWN_MODE` | 否 | `send`（默认）或 `draft` |

发信状态记录在 `docs/buttondown-state.json`（由脚本自动更新，会随 Actions 提交）。
