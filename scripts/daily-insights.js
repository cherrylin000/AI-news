#!/usr/bin/env node

/**
 * 每日AI洞察 - Feed拉取 + 洞察生成 + 站点发布（GitHub Pages / RSS）
 *
 * 用法:
 *   node daily-insights.js                  # 拉取→生成→发布 docs/（默认不发 SMTP）
 *   node daily-insights.js --fetch-only     # 仅拉取 feed
 *   node daily-insights.js --generate-only  # 生成并发布 docs/
 *   node daily-insights.js --send-only      # 从 outputs 加载并发布 docs/
 *   node daily-insights.js --legacy-smtp    # 在上述流程后 SMTP 群发给 recipients
 *   node daily-insights.js --dry-run        # 完整流程；若带 --legacy-smtp 则只模拟发信
 *
 * 环境变量:
 *   LLM_API_URL / LLM_API_KEY / LLM_MODEL   - 生成洞察（必填）
 *   SITE_URL                                - 站点根 URL（默认 https://cherrylin000.github.io/AI-news）
 *   FOLLOWIT_EMBED_HTML                     - follow.it 订阅表单嵌入 HTML（第 6 步填入）
 *   SMTP_*                                  - 仅 --legacy-smtp 时需要
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

/** 从项目根目录加载 .env（不覆盖已存在的系统环境变量） */
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

// ======================== 配置区 ========================

const CONFIG = {
  // Feed数据源URL
  feeds: {
    x: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
    podcasts: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
    blogs: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json',
  },

  // 📧 仅在使用 --legacy-smtp 时群发（日常订阅请用 follow.it + site/feed.xml）
  recipients: [],

  // GitHub Pages：首页在仓库根 index.html；邮件/RSS 在 docs/ 避免冲突
  repoRoot: path.join(__dirname, '..'),
  assetsDir: path.join(__dirname, '..', 'docs'),
  assetsUrlPath: '/docs',
  siteUrl: (process.env.SITE_URL || 'https://cherrylin000.github.io/AI-news').replace(/\/$/, ''),
  feedMaxItems: 60,

  // 邮件主题模板
  emailSubject: (date, title) => `AI洞察日报 | ${date} | ${title}`,

  // SMTP配置（通过环境变量或直接填写）
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },
  fromAddress: process.env.SMTP_FROM || process.env.SMTP_USER || '',

  // LLM API配置（用于AI洞察生成）
  llm: {
    apiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
  },

  // 输出目录
  outputBaseDir: path.join(__dirname, '..', 'outputs', '每日洞察'),

  // 筛选配置
  filter: {
    minLikes: 50,       // X推文最低点赞数阈值
    maxInsights: 8,     // 最大洞察条数
    minInsights: 5,     // 最小洞察条数
  },

  // 邮件发送间隔（毫秒），避免被限流
  sendInterval: 5000,
};

// ======================== 工具函数 ========================

/** HTTP GET请求（不依赖第三方库） */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON解析失败: ${url}\n${e.message}`));
        }
      });
    }).on('error', reject)
      .on('timeout', () => reject(new Error(`请求超时: ${url}`)));
  });
}

/** LLM API调用 */
async function callLLM(messages, temperature = 0.3) {
  if (!CONFIG.llm.apiKey) {
    throw new Error('未配置LLM_API_KEY，无法生成洞察。请设置环境变量 LLM_API_KEY');
  }

  const body = JSON.stringify({
    model: CONFIG.llm.model,
    messages,
    temperature,
    max_tokens: 4096,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.llm.apiUrl);
    const client = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.llm.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`LLM API错误: ${json.error.message || JSON.stringify(json.error)}`));
          } else {
            resolve(json.choices[0].message.content);
          }
        } catch (e) {
          reject(new Error(`LLM响应解析失败: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 格式化日期 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 确保目录存在 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** sleep */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ======================== Feed拉取 ========================

async function fetchFeeds() {
  console.log('📡 开始拉取Feed数据...');

  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJson(CONFIG.feeds.x),
    fetchJson(CONFIG.feeds.podcasts),
    fetchJson(CONFIG.feeds.blogs),
  ]);

  const result = {
    fetchedAt: new Date().toISOString(),
    x: feedX,
    podcasts: feedPodcasts,
    blogs: feedBlogs,
  };

  // 保存原始数据
  const today = formatDate(new Date());
  const outputDir = path.join(CONFIG.outputBaseDir, today.substring(0, 4), today.substring(5, 7));
  ensureDir(outputDir);
  const rawPath = path.join(outputDir, `${today}_raw_feeds.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`✅ Feed数据已保存: ${rawPath}`);

  // 统计
  const xBuilders = feedX.x?.length || 0;
  const xTweets = feedX.x?.reduce((sum, b) => sum + (b.tweets?.length || 0), 0) || 0;
  const podcastCount = feedPodcasts.podcasts?.length || 0;
  const blogCount = feedBlogs.blogs?.length || 0;
  console.log(`📊 统计: ${xBuilders}个Builder/${xTweets}条推文, ${podcastCount}期播客, ${blogCount}篇博客`);

  return result;
}

// ======================== Feed筛选 ========================

function filterFeeds(feeds) {
  const { minLikes, maxInsights } = CONFIG.filter;

  // 收集所有X推文，按点赞数排序
  const allTweets = [];
  if (feeds.x?.x) {
    for (const builder of feeds.x.x) {
      for (const tweet of (builder.tweets || [])) {
        allTweets.push({
          ...tweet,
          builderName: builder.name,
          builderHandle: builder.handle,
          builderBio: builder.bio,
        });
      }
    }
  }
  // 按点赞数降序
  allTweets.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  // 过滤低互动推文
  const filteredTweets = allTweets.filter((t) => (t.likes || 0) >= minLikes);

  // 播客（取最近的）
  const podcasts = feeds.podcasts?.podcasts || [];

  // 博客（取最近的）
  const blogs = feeds.blogs?.blogs || [];

  return {
    tweets: filteredTweets.slice(0, maxInsights),
    podcasts: podcasts.slice(0, 2),
    blogs: blogs.slice(0, 2),
    totalTweets: allTweets.length,
    filteredTweetCount: filteredTweets.length,
  };
}

// ======================== AI洞察生成 ========================

async function generateInsights(filteredData) {
  console.log('🤖 调用LLM生成洞察摘要...');

  // 构建待分析的原始材料
  const material = buildMaterialForLLM(filteredData);

  const systemPrompt = `你是一位AI行业分析师，负责从Builder动态中提炼每日高价值洞察。
要求：
1. 从提供的Feed数据中筛选5-8条最有洞察力的内容
2. 聚焦技术突破、行业洞察、实战经验
3. 每条洞察必须包含：英文原文摘要 + 中文翻译 + 原文链接
4. 必须从feed数据中提取真实的英文原文，禁止自行翻译生成英文
5. 最后生成一条Today's Top Takeaway（中英双语），综合当日核心趋势
6. 输出严格遵循JSON格式

输出JSON格式：
{
  "title_en": "英文主标题",
  "title_cn": "中文主标题",
  "insights": {
    "x": [
      {
        "builder": "Builder名称",
        "role": "职位/公司",
        "en_summary": "英文摘要（从原文提炼）",
        "cn_summary": "中文翻译",
        "url": "原文链接",
        "original_text": "推文原文"
      }
    ],
    "podcasts": [
      {
        "name": "播客名称",
        "episode": "节目标题",
        "en_summary": "英文摘要",
        "cn_summary": "中文翻译",
        "url": "链接"
      }
    ],
    "blogs": [
      {
        "name": "博客来源",
        "title": "文章标题",
        "en_summary": "英文摘要",
        "cn_summary": "中文翻译",
        "url": "链接"
      }
    ]
  },
  "quick_hits": [
    { "builder": "名称", "company": "公司", "en": "英文洞察", "cn": "中文洞察" }
  ],
  "takeaway": {
    "title_en": "英文核心主题",
    "title_cn": "中文核心主题",
    "overview_en": "英文概述",
    "overview_cn": "中文概述",
    "key_points_en": [{ "title": "要点标题", "content": "要点内容" }],
    "key_points_cn": [{ "title": "要点标题", "content": "要点内容" }],
    "implications_en": [{ "title": "启示标题", "content": "启示内容" }],
    "implications_cn": [{ "title": "启示标题", "content": "启示内容" }],
    "bottom_line_en": "英文总结",
    "bottom_line_cn": "中文总结"
  }
}`;

  const userPrompt = `以下是今日Feed数据，请分析并生成洞察：

${material}`;

  const response = await callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 0.3);

  // 解析JSON（兼容markdown代码块包裹）
  let jsonStr = response.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const insights = JSON.parse(jsonStr);
    console.log(`✅ 洞察生成完成: ${insights.insights?.x?.length || 0}条X, ${insights.insights?.podcasts?.length || 0}条播客, ${insights.insights?.blogs?.length || 0}条博客`);
    return insights;
  } catch (e) {
    console.error('❌ LLM输出JSON解析失败，原始输出前500字符:');
    console.error(jsonStr.substring(0, 500));
    throw new Error('LLM输出格式错误，请重试或调整prompt');
  }
}

function buildMaterialForLLM(filteredData) {
  const parts = [];

  // X/Twitter数据
  if (filteredData.tweets.length > 0) {
    parts.push('## X / Twitter');
    for (const t of filteredData.tweets) {
      parts.push(`### ${t.builderName} (@${t.builderHandle}) - ${t.builderBio || ''}`);
      parts.push(`内容: ${t.text}`);
      parts.push(`互动: ${t.likes} likes, ${t.retweets} retweets`);
      parts.push(`链接: ${t.url}`);
      parts.push('');
    }
  }

  // 播客数据
  if (filteredData.podcasts.length > 0) {
    parts.push('## Podcasts');
    for (const p of filteredData.podcasts) {
      parts.push(`### ${p.name}: ${p.title}`);
      parts.push(`发布时间: ${p.publishedAt}`);
      parts.push(`链接: ${p.url}`);
      if (p.transcript) {
        // 截取transcript前3000字符避免超长
        parts.push(`转录稿(节选): ${p.transcript.substring(0, 3000)}...`);
      }
      parts.push('');
    }
  }

  // 博客数据
  if (filteredData.blogs.length > 0) {
    parts.push('## Official Blogs');
    for (const b of filteredData.blogs) {
      parts.push(`### ${b.name}: ${b.title}`);
      parts.push(`发布时间: ${b.publishedAt}`);
      parts.push(`链接: ${b.url}`);
      if (b.content) {
        parts.push(`内容(节选): ${b.content.substring(0, 3000)}...`);
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

// ======================== Markdown生成 ========================

function generateMarkdown(insights, date) {
  const lines = [];

  lines.push(`---`);
  lines.push(`Created: ${date}`);
  lines.push(`---`);
  lines.push('');
  lines.push(`# ${date} | ${insights.title_en}`);
  lines.push('');
  lines.push(`# ${date.replace(/-/g, '年', 1).replace(/-/, '月')}日 | ${insights.title_cn}`);
  lines.push('');

  // X / Twitter
  const xItems = insights.insights?.x || [];
  if (xItems.length > 0) {
    lines.push('## X / Twitter');
    lines.push('');
    for (const item of xItems) {
      lines.push(`### ${item.builder} (${item.role})`);
      lines.push(item.en_summary);
      lines.push(item.cn_summary);
      lines.push(`🔗 [原文链接](${item.url})`);
      lines.push('');
    }
  }

  // Podcasts
  const podItems = insights.insights?.podcasts || [];
  if (podItems.length > 0) {
    lines.push('## Podcasts');
    lines.push('');
    for (const item of podItems) {
      lines.push(`### ${item.name}: ${item.episode}`);
      lines.push(item.en_summary);
      lines.push(item.cn_summary);
      lines.push(`🔗 [原文链接](${item.url})`);
      lines.push('');
    }
  }

  // Official Blogs
  const blogItems = insights.insights?.blogs || [];
  if (blogItems.length > 0) {
    lines.push('## Official Blogs');
    lines.push('');
    for (const item of blogItems) {
      lines.push(`### ${item.name}: ${item.title}`);
      lines.push(item.en_summary);
      lines.push(item.cn_summary);
      lines.push(`🔗 [原文链接](${item.url})`);
      lines.push('');
    }
  }

  // Quick Hits
  const quickHits = insights.quick_hits || [];
  if (quickHits.length > 0) {
    lines.push('## Quick Hits | 快讯速览');
    lines.push('');
    lines.push('| Builder | Insight | 洞察 |');
    lines.push('|---------|---------|------|');
    for (const q of quickHits) {
      lines.push(`| **${q.builder}** (${q.company}) | ${q.en} | ${q.cn} |`);
    }
    lines.push('');
  }

  // Top Takeaway
  const tw = insights.takeaway;
  if (tw) {
    lines.push('## 🔥 Today\'s Top Takeaway');
    lines.push('');
    lines.push(`**${tw.title_en}**`);
    lines.push('');
    if (tw.overview_en) lines.push(tw.overview_en);
    if (tw.key_points_en?.length) {
      lines.push('');
      lines.push('**Key Points:**');
      tw.key_points_en.forEach((p, i) => lines.push(`${i + 1}. **${p.title}**: ${p.content}`));
    }
    if (tw.implications_en?.length) {
      lines.push('');
      lines.push('**Implications:**');
      tw.implications_en.forEach((p, i) => lines.push(`${i + 1}. **${p.title}**: ${p.content}`));
    }
    if (tw.bottom_line_en) {
      lines.push('');
      lines.push(`**Bottom line**: ${tw.bottom_line_en}`);
    }
    lines.push('');
    lines.push(`**${tw.title_cn}**`);
    lines.push('');
    if (tw.overview_cn) lines.push(tw.overview_cn);
    if (tw.key_points_cn?.length) {
      lines.push('');
      lines.push('**关键要点：**');
      tw.key_points_cn.forEach((p, i) => lines.push(`${i + 1}. **${p.title}**: ${p.content}`));
    }
    if (tw.implications_cn?.length) {
      lines.push('');
      lines.push('**启示：**');
      tw.implications_cn.forEach((p, i) => lines.push(`${i + 1}. **${p.title}**: ${p.content}`));
    }
    if (tw.bottom_line_cn) {
      lines.push('');
      lines.push(`**总结**：${tw.bottom_line_cn}`);
    }
  }

  // 统计
  const totalCount = xItems.length + podItems.length + blogItems.length;
  lines.push('');
  lines.push(`---`);
  lines.push(`共${totalCount}条高价值洞察`);
  lines.push('');
  lines.push('#AI');

  return lines.join('\n');
}

// ======================== HTML生成 ========================

function generateHTML(insights, date) {
  const dateCN = date.replace(/(\d{4})-(\d{2})-(\d{2})/, (_, y, m, d) => `${y}年${parseInt(m)}月${parseInt(d)}日`);

  let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
</head>
<body style="margin:0; padding:20px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff">
<tbody><tr>
<td>
<table width="720" cellpadding="20" cellspacing="0" align="center" bgcolor="#ffffff" style="border:1px solid #e5e7eb; border-radius:8px;">
<tbody>

<!-- Header -->
<tr>
<td bgcolor="#f8fafc" style="border-bottom:3px solid #6366f1; padding:24px;">
<h1 style="margin:0; font-size:26px; color:#111827;">📅 ${date} | ${insights.title_cn}</h1>
<p style="margin:8px 0 0 0; color:#6b7280; font-size:15px;">${insights.title_en}</p>
</td>
</tr>`;

  // X / Twitter
  const xItems = insights.insights?.x || [];
  if (xItems.length > 0) {
    html += `
<tr>
<td style="padding:24px 20px;">
<h2 style="margin:0 0 16px 0; font-size:20px; color:#6366f1; padding-left:14px; border-left:4px solid #6366f1;">📱 X / Twitter</h2>`;
    for (const item of xItems) {
      html += `
<h3 style="margin:20px 0 12px 0; font-size:17px; color:#111827;">${item.builder} (${item.role})</h3>
<table width="100%" cellpadding="16" cellspacing="0" bgcolor="#f9fafb" style="border:1px solid #e5e7eb; border-radius:8px;">
<tbody><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0;">
<tbody><tr><td style="padding-left:14px;">
<p style="margin:0; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(item.en_summary)}</p>
</td></tr></tbody>
</table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
<tbody><tr><td style="padding-left:14px;">
<p style="margin:0; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(item.cn_summary)}</p>
</td></tr></tbody>
</table>
<p style="margin:12px 0 0 0;"><a href="${item.url}" style="color:#6366f1; text-decoration:none; font-size:13px;">🔗 原文链接</a></p>
</td></tr></tbody></table>`;
    }
    html += `
</td>
</tr>`;
  }

  // Podcasts
  const podItems = insights.insights?.podcasts || [];
  if (podItems.length > 0) {
    html += `
<tr>
<td style="padding:0 20px 24px 20px;">
<h2 style="margin:0 0 16px 0; font-size:20px; color:#6366f1; padding-left:14px; border-left:4px solid #6366f1;">🎙️ Podcasts</h2>`;
    for (const item of podItems) {
      html += `
<h3 style="margin:20px 0 12px 0; font-size:17px; color:#111827;">${escapeHtml(item.name)}: ${escapeHtml(item.episode)}</h3>
<table width="100%" cellpadding="16" cellspacing="0" bgcolor="#f9fafb" style="border:1px solid #e5e7eb; border-radius:8px;">
<tbody><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0;">
<tbody><tr><td style="padding-left:14px;">
<p style="margin:0; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(item.en_summary)}</p>
</td></tr></tbody>
</table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
<tbody><tr><td style="padding-left:14px;">
<p style="margin:0; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(item.cn_summary)}</p>
</td></tr></tbody>
</table>
<p style="margin:12px 0 0 0;"><a href="${item.url}" style="color:#6366f1; text-decoration:none; font-size:13px;">🔗 原文链接</a></p>
</td></tr></tbody></table>`;
    }
    html += `
</td>
</tr>`;
  }

  // Official Blogs
  const blogItems = insights.insights?.blogs || [];
  if (blogItems.length > 0) {
    html += `
<tr>
<td style="padding:0 20px 24px 20px;">
<h2 style="margin:0 0 16px 0; font-size:20px; color:#6366f1; padding-left:14px; border-left:4px solid #6366f1;">📝 Official Blogs</h2>`;
    for (const item of blogItems) {
      html += `
<h3 style="margin:20px 0 12px 0; font-size:17px; color:#111827;">${escapeHtml(item.name)}: ${escapeHtml(item.title)}</h3>
<table width="100%" cellpadding="16" cellspacing="0" bgcolor="#f9fafb" style="border:1px solid #e5e7eb; border-radius:8px;">
<tbody><tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0;">
<tbody><tr><td style="padding-left:14px;">
<p style="margin:0; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(item.en_summary)}</p>
</td></tr></tbody>
</table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
<tbody><tr><td style="padding-left:14px;">
<p style="margin:0; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(item.cn_summary)}</p>
</td></tr></tbody>
</table>
<p style="margin:12px 0 0 0;"><a href="${item.url}" style="color:#6366f1; text-decoration:none; font-size:13px;">🔗 原文链接</a></p>
</td></tr></tbody></table>`;
    }
    html += `
</td>
</tr>`;
  }

  // Quick Hits
  const quickHits = insights.quick_hits || [];
  if (quickHits.length > 0) {
    html += `
<tr>
<td style="padding:0 20px 24px 20px;">
<h2 style="margin:0 0 16px 0; font-size:20px; color:#f59e0b;">⚡ Quick Hits | 快讯速览</h2>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
<tbody>
<tr bgcolor="#f59e0b">
<th style="padding:12px 14px; text-align:left; color:#ffffff; font-size:14px; font-weight:600;">Builder</th>
<th style="padding:12px 14px; text-align:left; color:#ffffff; font-size:14px; font-weight:600;">Insight</th>
<th style="padding:12px 14px; text-align:left; color:#ffffff; font-size:14px; font-weight:600;">洞察</th>
</tr>`;
    for (const q of quickHits) {
      html += `
<tr bgcolor="#ffffff">
<td style="padding:12px 14px; color:#333333; font-size:14px;"><strong>${escapeHtml(q.builder)}</strong><br>(${escapeHtml(q.company)})</td>
<td style="padding:12px 14px; color:#333333; font-size:14px;">${escapeHtml(q.en)}</td>
<td style="padding:12px 14px; color:#333333; font-size:14px;">${escapeHtml(q.cn)}</td>
</tr>`;
    }
    html += `
</tbody>
</table>
</td>
</tr>`;
  }

  // Top Takeaway
  const tw = insights.takeaway;
  if (tw) {
    html += `
<tr>
<td style="padding:0 20px 24px 20px;">
<h2 style="margin:0 0 16px 0; font-size:22px; color:#dc2626;">🔥 Today's Top Takeaway</h2>
<div style="background:#fef2f2; border:2px solid #dc2626; padding:16px; border-radius:8px;">
<p style="margin:0; font-weight:600; color:#991b1b; font-size:18px;">${escapeHtml(tw.title_en)}</p>`;

    if (tw.overview_en) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(tw.overview_en)}</p>`;
    }
    if (tw.key_points_en?.length) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;"><strong>Key Points:</strong><br><br>`;
      tw.key_points_en.forEach((p, i) => {
        html += `<strong>${i + 1}. ${escapeHtml(p.title)}:</strong> ${escapeHtml(p.content)}<br>`;
      });
      html += `</p>`;
    }
    if (tw.implications_en?.length) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;"><strong>Implications:</strong><br><br>`;
      tw.implications_en.forEach((p, i) => {
        html += `<strong>${i + 1}. ${escapeHtml(p.title)}:</strong> ${escapeHtml(p.content)}<br>`;
      });
      html += `</p>`;
    }
    if (tw.bottom_line_en) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;"><strong>Bottom line:</strong> ${escapeHtml(tw.bottom_line_en)}</p>`;
    }

    html += `<p style="margin-top:16px; font-weight:600; color:#991b1b; font-size:18px;">${escapeHtml(tw.title_cn)}</p>`;

    if (tw.overview_cn) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;">${escapeHtml(tw.overview_cn)}</p>`;
    }
    if (tw.key_points_cn?.length) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;"><strong>关键要点：</strong><br><br>`;
      tw.key_points_cn.forEach((p, i) => {
        html += `<strong>${i + 1}. ${escapeHtml(p.title)}:</strong> ${escapeHtml(p.content)}<br>`;
      });
      html += `</p>`;
    }
    if (tw.implications_cn?.length) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;"><strong>启示：</strong><br><br>`;
      tw.implications_cn.forEach((p, i) => {
        html += `<strong>${i + 1}. ${escapeHtml(p.title)}:</strong> ${escapeHtml(p.content)}<br>`;
      });
      html += `</p>`;
    }
    if (tw.bottom_line_cn) {
      html += `<p style="margin-top:12px; padding:8px; background:#fee2e2; border-radius:4px; color:#333333; font-size:14px; line-height:1.7;"><strong>总结：</strong>${escapeHtml(tw.bottom_line_cn)}</p>`;
    }

    html += `
</div>
</td>
</tr>`;
  }

  // Footer
  const totalCount = xItems.length + podItems.length + blogItems.length;
  html += `
<tr>
<td style="padding:20px; text-align:center; border-top:1px solid #e5e7eb;">
<p style="margin:0; color:#9ca3af; font-size:13px;">共${totalCount}条高价值洞察</p>
</td>
</tr>

</tbody></table>
</td>
</tr>
</tbody></table>
</body></html>`;

  return html;
}

/** HTML转义 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

/** XML 转义（RSS 文本节点） */
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA 安全包裹（用于 RSS 内嵌完整 HTML 邮件正文） */
function wrapCdata(str) {
  if (!str) return '';
  return String(str).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

// ======================== 站点发布（GitHub Pages + RSS） ========================

function toRssPubDate(dateStr) {
  return new Date(`${dateStr}T08:00:00+08:00`).toUTCString();
}

function buildRssSummary(insights, date) {
  const lines = [`${date} | ${insights.title_cn}`, '', insights.title_en, ''];
  const tw = insights.takeaway;
  if (tw?.overview_cn) lines.push(tw.overview_cn);
  else if (tw?.overview_en) lines.push(tw.overview_en);

  const xItems = insights.insights?.x || [];
  if (xItems.length > 0) {
    lines.push('', '---', '');
    for (const item of xItems.slice(0, 4)) {
      lines.push(`• ${item.builder}: ${item.cn_summary || item.en_summary}`);
    }
  }

  let text = lines.join('\n').trim();
  if (text.length > 2000) text = `${text.substring(0, 1997)}...`;
  return text;
}

function loadFeedItems() {
  const feedItemsPath = path.join(CONFIG.assetsDir, 'feed-items.json');
  if (!fs.existsSync(feedItemsPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(feedItemsPath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveFeedItems(items) {
  const feedItemsPath = path.join(CONFIG.assetsDir, 'feed-items.json');
  fs.writeFileSync(
    feedItemsPath,
    JSON.stringify(items.slice(0, CONFIG.feedMaxItems), null, 2),
    'utf-8',
  );
}

function generateRssXml(items) {
  const channelLink = `${CONFIG.siteUrl}/`;
  const itemXml = items
    .map((item) => {
      const desc = item.description || '';
      const fullHtml = item.contentHtml || '';
      const encodedBlock = fullHtml
        ? `\n      <content:encoded><![CDATA[${wrapCdata(fullHtml)}]]></content:encoded>`
        : '';
      return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.guid)}</guid>
      <pubDate>${escapeXml(item.pubDate)}</pubDate>
      <description><![CDATA[${wrapCdata(desc)}]]></description>${encodedBlock}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>AI洞察日报</title>
    <link>${escapeXml(channelLink)}</link>
    <description>每日 AI Builder 洞察摘要（中英双语）</description>
    <language>zh-CN</language>
    <lastBuildDate>${escapeXml(items[0]?.pubDate || new Date().toUTCString())}</lastBuildDate>
    <atom:link href="${escapeXml(`${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/feed.xml`)}" rel="self" type="application/rss+xml"/>
${itemXml}
  </channel>
</rss>
`;
}

function getSubscribeEmbedHtml() {
  const custom = process.env.FOLLOWIT_EMBED_HTML;
  if (custom && custom.trim()) return custom.trim();
  return `<div class="subscribe-placeholder">
  <p><strong>邮件订阅</strong>：第 6 步将在 follow.it 获取嵌入代码，并写入环境变量 <code>FOLLOWIT_EMBED_HTML</code> 或替换本占位区。</p>
  <p>RSS 地址（供 follow.it 绑定）：<br><a href="${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/feed.xml">${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/feed.xml</a></p>
</div>`;
}

function generateLandingPage(insights, date) {
  const title = insights.title_cn || insights.title_en || 'AI洞察日报';
  const subscribeHtml = getSubscribeEmbedHtml();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI洞察日报 | ${escapeHtml(date)}</title>
  <link rel="alternate" type="application/rss+xml" title="AI洞察日报" href="${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/feed.xml">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans SC", sans-serif; background: #f1f5f9; color: #111827; }
    .wrap { max-width: 800px; margin: 0 auto; padding: 24px 16px 48px; }
    header { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 20px; border-bottom: 3px solid #6366f1; }
    header h1 { margin: 0 0 8px; font-size: 1.5rem; }
    header p { margin: 0; color: #6b7280; font-size: 0.95rem; }
    section { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    section h2 { margin: 0 0 16px; font-size: 1.1rem; color: #6366f1; }
    .preview-frame { width: 100%; min-height: 720px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
    .subscribe-placeholder { background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 16px; font-size: 0.9rem; line-height: 1.6; }
    .subscribe-placeholder code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; }
    footer { text-align: center; color: #9ca3af; font-size: 0.85rem; }
    footer a { color: #6366f1; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>📅 AI洞察日报</h1>
      <p>${escapeHtml(date)} · ${escapeHtml(title)}</p>
      <p style="margin-top:8px;font-size:0.85rem;">下方为今日邮件预览；订阅后由 follow.it 每日推送（含退订入口）。</p>
    </header>

    <section>
      <h2>📧 今日邮件预览</h2>
      <iframe class="preview-frame" src="docs/latest.html" title="今日洞察邮件预览"></iframe>
      <p style="margin:12px 0 0;font-size:0.85rem;"><a href="docs/latest.html" target="_blank" rel="noopener">在新标签页打开完整预览</a>
        · <a href="docs/archive/${date}.html" target="_blank" rel="noopener">归档链接</a></p>
    </section>

    <section id="subscribe">
      <h2>✉️ 订阅每日邮件</h2>
      ${subscribeHtml}
    </section>

    <footer>
      <p><a href="docs/feed.xml">RSS Feed</a> · 由 <a href="https://github.com/cherrylin000/AI-news">AI-news</a> 自动生成</p>
    </footer>
  </div>
</body>
</html>
`;
}

function publishSite(insights, date, htmlContent) {
  const archiveDir = path.join(CONFIG.assetsDir, 'archive');
  ensureDir(CONFIG.assetsDir);
  ensureDir(archiveDir);

  const latestPath = path.join(CONFIG.assetsDir, 'latest.html');
  const archivePath = path.join(archiveDir, `${date}.html`);
  const indexPath = path.join(CONFIG.repoRoot, 'index.html');
  const feedPath = path.join(CONFIG.assetsDir, 'feed.xml');
  const legacyIndexPath = path.join(CONFIG.assetsDir, 'index.html');

  fs.writeFileSync(latestPath, htmlContent, 'utf-8');
  fs.writeFileSync(archivePath, htmlContent, 'utf-8');
  fs.writeFileSync(indexPath, generateLandingPage(insights, date), 'utf-8');
  fs.writeFileSync(path.join(CONFIG.repoRoot, '.nojekyll'), '', 'utf-8');
  if (fs.existsSync(legacyIndexPath)) fs.unlinkSync(legacyIndexPath);

  const itemLink = `${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/latest.html`;
  const archiveLink = `${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/archive/${date}.html`;
  const title = `AI洞察日报 | ${date} | ${insights.title_cn || insights.title_en}`;
  const summary = buildRssSummary(insights, date);
  // description：邮件客户端摘要；contentHtml：与 latest.html 相同的完整邮件 HTML（供 follow.it Full stories）
  const descriptionHtml = `<p>${escapeHtml(summary).replace(/&lt;br&gt;/g, '<br>')}</p><p><a href="${archiveLink}">归档链接</a></p>`;

  let items = loadFeedItems().filter((item) => item.date !== date);
  items.unshift({
    date,
    title,
    link: itemLink,
    guid: `${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/digest/${date}.html`,
    pubDate: toRssPubDate(date),
    description: descriptionHtml,
    contentHtml: htmlContent,
  });
  saveFeedItems(items);
  fs.writeFileSync(feedPath, generateRssXml(items), 'utf-8');

  console.log(`\n🌐 站点已发布`);
  console.log(`   首页: ${CONFIG.siteUrl}/`);
  console.log(`   邮件预览: ${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/latest.html`);
  console.log(`   RSS: ${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/feed.xml`);
}

// ======================== 邮件发送（--legacy-smtp） ========================

async function sendEmails(htmlContent, mdContent, date, title) {
  if (!CONFIG.smtp.host || !CONFIG.smtp.auth.user || !CONFIG.smtp.auth.pass) {
    console.error('❌ SMTP未配置。请设置环境变量: SMTP_HOST, SMTP_USER, SMTP_PASS');
    console.log('💡 提示: HTML和MD文件已生成，可手动发送或通过其他方式推送');
    return false;
  }

  // 动态加载nodemailer
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    console.error('❌ 未安装nodemailer。请运行: npm install nodemailer');
    return false;
  }

  const transporter = nodemailer.createTransport(CONFIG.smtp);
  const subject = CONFIG.emailSubject(date, title);

  console.log(`📧 开始发送邮件，共${CONFIG.recipients.length}位收件人...`);
  console.log(`📧 主题: ${subject}`);

  const results = [];
  for (let i = 0; i < CONFIG.recipients.length; i++) {
    const recipient = CONFIG.recipients[i];
    console.log(`📧 [${i + 1}/${CONFIG.recipients.length}] 发送至: ${recipient.name} <${recipient.address}>`);

    try {
      const info = await transporter.sendMail({
        from: CONFIG.fromAddress || CONFIG.smtp.auth.user,
        to: `"${recipient.name}" <${recipient.address}>`,
        subject,
        html: htmlContent,
        attachments: [
          {
            filename: `${date}_${title.replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, '').trim().substring(0, 50)}.md`,
            content: mdContent,
            contentType: 'text/markdown',
          },
        ],
      });
      console.log(`   ✅ 发送成功: ${info.messageId}`);
      results.push({ recipient: recipient.address, success: true, messageId: info.messageId });
    } catch (err) {
      console.error(`   ❌ 发送失败: ${err.message}`);
      results.push({ recipient: recipient.address, success: false, error: err.message });
    }

    // 间隔发送，避免限流
    if (i < CONFIG.recipients.length - 1) {
      console.log(`   ⏳ 等待${CONFIG.sendInterval / 1000}秒...`);
      await sleep(CONFIG.sendInterval);
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  console.log(`\n📧 发送完成: ${successCount}成功, ${failCount}失败`);

  return failCount === 0;
}

// ======================== 主流程 ========================

async function main() {
  const args = process.argv.slice(2);
  const fetchOnly = args.includes('--fetch-only');
  const generateOnly = args.includes('--generate-only');
  const sendOnly = args.includes('--send-only');
  const dryRun = args.includes('--dry-run');
  const legacySmtp = args.includes('--legacy-smtp');

  const today = formatDate(new Date());
  const outputDir = path.join(CONFIG.outputBaseDir, today.substring(0, 4), today.substring(5, 7));
  ensureDir(outputDir);

  console.log(`\n🚀 每日AI洞察 - ${today}`);
  console.log(`📁 输出目录: ${outputDir}\n`);

  let feeds, insights, mdContent, htmlContent;

  // Step 1: 拉取Feed
  if (!sendOnly) {
    feeds = await fetchFeeds();
  } else {
    // 从已保存的raw feeds加载
    const rawPath = path.join(outputDir, `${today}_raw_feeds.json`);
    if (!fs.existsSync(rawPath)) {
      console.error(`❌ 未找到今日feed数据: ${rawPath}`);
      process.exit(1);
    }
    feeds = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    console.log(`📂 已加载Feed数据: ${rawPath}`);
  }

  if (fetchOnly) {
    console.log('\n✅ --fetch-only 模式，仅拉取feed，流程结束');
    return;
  }

  // Step 2: 筛选 + AI生成洞察
  if (!sendOnly) {
    const filtered = filterFeeds(feeds);
    console.log(`🔍 筛选结果: ${filtered.tweets.length}条推文(>=${CONFIG.filter.minLikes}赞), ${filtered.podcasts.length}期播客, ${filtered.blogs.length}篇博客`);

    insights = await generateInsights(filtered);

    // Step 3: 生成MD和HTML
    mdContent = generateMarkdown(insights, today);
    htmlContent = generateHTML(insights, today);

    // 保存文件
    const titleSlug = insights.title_en.replace(/[^a-zA-Z0-9\s]/g, '').trim().substring(0, 60).replace(/\s+/g, ' ');
    const mdPath = path.join(outputDir, `${today}_${titleSlug}.md`);
    const htmlPath = path.join(outputDir, `${today}_email.html`);

    fs.writeFileSync(mdPath, mdContent, 'utf-8');
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
    console.log(`\n📄 MD已保存: ${mdPath}`);
    console.log(`📄 HTML已保存: ${htmlPath}`);

    // 同时保存insights JSON以便后续重用
    const jsonPath = path.join(outputDir, `${today}_insights.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(insights, null, 2), 'utf-8');
    console.log(`📄 JSON已保存: ${jsonPath}`);
  } else {
    // 从已保存的文件加载
    const jsonPath = path.join(outputDir, `${today}_insights.json`);
    if (!fs.existsSync(jsonPath)) {
      console.error(`❌ 未找到今日洞察数据: ${jsonPath}`);
      process.exit(1);
    }
    insights = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const htmlPath = path.join(outputDir, `${today}_email.html`);
    const mdPath = path.join(outputDir, `${today}_${insights.title_en.replace(/[^a-zA-Z0-9\s]/g, '').trim().substring(0, 60).replace(/\s+/g, ' ')}.md`);
    htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    mdContent = fs.readFileSync(mdPath, 'utf-8');
    console.log(`📂 已加载洞察和邮件内容`);
  }

  // 发布 GitHub Pages 站点与 RSS（有洞察数据时）
  if (insights && htmlContent) {
    publishSite(insights, today, htmlContent);
  }

  if (generateOnly) {
    console.log('\n✅ --generate-only 完成（已更新 docs/）');
    return;
  }

  if (dryRun) {
    console.log('\n🏃 --dry-run 模式');
    if (legacySmtp) {
      console.log(`📧 若启用 SMTP，将发送给 ${CONFIG.recipients.length} 位收件人:`);
      CONFIG.recipients.forEach((r) => console.log(`   - ${r.name} <${r.address}>`));
    } else {
      console.log('📬 默认不发 SMTP；订阅由 follow.it + feed.xml 处理。');
    }
    return;
  }

  if (legacySmtp) {
    if (CONFIG.recipients.length === 0) {
      console.error('❌ --legacy-smtp 需要先在 CONFIG.recipients 中配置收件人');
      process.exit(1);
    }
    await sendEmails(htmlContent, mdContent, today, insights.title_cn || insights.title_en);
  } else {
    console.log('\n📬 已跳过 SMTP 群发（用户通过网页订阅 / follow.it）。');
    console.log('   若需恢复旧版群发: node daily-insights.js --legacy-smtp');
  }

  console.log('\n✅ 全部流程完成！');
}

// 执行
main().catch((err) => {
  console.error('\n❌ 执行失败:', err.message);
  process.exit(1);
});
