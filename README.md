# AI-news

每日 AI 洞察：从 Builder Feed 拉取内容，经 LLM 生成中英双语摘要，并发布订阅页面与 RSS。

## 项目结构

```
scripts/              # 主脚本（daily-insights.js）
outputs/              # 本地生成产物（不提交到 Git）
index.html            # GitHub Pages 首页（部署选根目录 /）
docs/
  latest.html         # 当日邮件 HTML 预览
  feed.xml            # RSS（follow.it 绑定）
  feed-items.json     # RSS 条目元数据
  archive/            # 历史邮件 HTML 归档（YYYY-MM-DD.html）
```

脚本与 GitHub Actions **只写入 `docs/`**，不再使用已废弃的 `site/` 目录。

## 本地运行

```bash
cd scripts
npm install
# 配置环境变量后：
node daily-insights.js --generate-only
```

详见 [scripts/README.md](scripts/README.md)。

## 密钥与在线运行

- 本地：在项目根目录 `.env` 填写 `LLM_API_KEY`（勿提交）
- 云端：在 GitHub **Settings → Secrets and variables → Actions** 配置同名变量
- 完整步骤：[docs/SECRETS.md](docs/SECRETS.md)

## 订阅（follow.it）

- 预览页：`https://cherrylin000.github.io/AI-news/`（需先开启 GitHub Pages，见路线图第 5 步）
- RSS：`https://cherrylin000.github.io/AI-news/docs/feed.xml`
- 默认不再 SMTP 群发；恢复旧行为：`npm run legacy-smtp`（需在脚本中配置 `recipients`）
