# AI-news

每日 AI 洞察：从 Builder Feed 拉取内容，经 LLM 生成中英双语摘要，并发布订阅页面与 RSS。

## 项目结构

```
scripts/          # 主脚本（daily-insights.js）
outputs/          # 本地生成产物（不提交到 Git）
site/             # GitHub Pages 站点（后续步骤添加）
```

## 本地运行

```bash
cd scripts
npm install
# 配置环境变量后：
node daily-insights.js --generate-only
```

详见 [scripts/README.md](scripts/README.md)。

## 订阅

站点与 RSS 订阅功能搭建中，完成后预览页将发布在 GitHub Pages。
