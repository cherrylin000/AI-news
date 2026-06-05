# 密钥配置：本地试跑 + GitHub 在线运行

## 原则

| 位置 | 放什么 | 是否提交 Git |
|------|--------|--------------|
| **`.env`**（项目根目录） | 本地开发用密钥 | ❌ 永不提交（已在 `.gitignore`） |
| **GitHub Secrets** | 云端 Actions 用密钥 | ✅ 加密存于 GitHub |
| **`.env.example`** | 仅变量名与示例 URL | ✅ 可提交，不含真实密钥 |

不要在代码、Issue、聊天记录里粘贴 `sk-` 密钥。若曾泄露，请到 [DeepSeek 控制台](https://platform.deepseek.com/) **作废并新建** Key。

---

## 一、清理本地高风险配置

1. 打开项目根目录 **`AI news/.env`**（与 `scripts` 同级）。
2. 确认 **`LLM_API_KEY` 只有占位或你自己的新 Key**，不要把旧 Key 写进任何会提交的文件。
3. 确认 Git 未跟踪 `.env`：

   ```powershell
   cd "你的项目路径\AI news"
   git status
   ```

   若出现 `.env`，**不要** `git add .env`；若误提交过，需轮换 Key 并联系处理历史记录。

4. 本地 `.env` 推荐格式（密钥只填在本地文件）：

   ```env
   SITE_URL=https://cherrylin000.github.io/AI-news
   LLM_API_URL=https://api.deepseek.com/chat/completions
   LLM_API_KEY=在这里粘贴你的新密钥
   LLM_MODEL=deepseek-v4-flash
   ```

---

## 二、在 GitHub 配置 Secrets（在线运行）

1. 打开仓库：<https://github.com/cherrylin000/AI-news>
2. **Settings** → 左侧 **Secrets and variables** → **Actions**
3. 点击 **New repository secret**，逐个添加：

| Secret 名称 | 必填 | 值（示例） |
|-------------|------|------------|
| `LLM_API_KEY` | ✅ | DeepSeek 新 Key（`sk-...`） |
| `LLM_API_URL` | 建议 | `https://api.deepseek.com/chat/completions` |
| `LLM_MODEL` | 建议 | `deepseek-v4-flash` |

follow.it 订阅表单请**直接写入根目录 `index.html`**（`<!-- ai-news:dynamic-end -->` 之后）；脚本与 Actions 只更新动态区，不会覆盖订阅嵌入代码。

4. 保存后，在 **Actions** 页选择 **Daily AI Insights** → **Run workflow** 手动试跑。

定时任务：每天 **北京时间 8:00**（workflow 内 `Asia/Shanghai`）。

---

## 三、开启 GitHub Pages（预览站 + RSS）

1. 仓库 **Settings** → **Pages**
2. **Build and deployment** → Source: **Deploy from a branch**
3. Branch: **`main`**，Folder: **`/ (root)`**（首页 `index.html` 在根目录；`docs/` 仅放邮件预览与 RSS）
4. 保存后等待 1～3 分钟，访问：<https://cherrylin000.github.io/AI-news/>

首次需先成功运行一次 Actions（或本地生成后提交 `docs/`），页面才有完整内容。

---

## 四、本地试跑

```powershell
cd "c:\Users\linhy\Documents\1. Projects\9. Github Projects\AI news\scripts"
npm install
node daily-insights.js --generate-only
```

脚本会自动读取上级目录的 **`.env`**。成功时终端有 `🌐 站点已发布`，并更新 `docs/` 目录。

---

## 五、本地 vs 云端对照

| | 本地 | GitHub Actions |
|--|------|----------------|
| 密钥来源 | `.env` | Repository Secrets |
| 触发 | 手动 `node daily-insights.js` | 每天 8:00 或手动 Run workflow |
| 站点更新 | 本地 `docs/` | Actions 自动 commit `docs/` 并 push |

两者可使用**同一个** DeepSeek Key，但务必使用**轮换后的新 Key**，且仅存在于 `.env` 与 Secrets 两处。
