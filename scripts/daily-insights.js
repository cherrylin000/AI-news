#!/usr/bin/env node

/**
 * 每日AI洞察 - Feed拉取 + 洞察生成 + 站点发布（GitHub Pages / RSS）
 *
 * 用法:
 *   node daily-insights.js                  # 拉取→生成→发布 docs/（默认不发 SMTP）
 *   node daily-insights.js --fetch-only     # 仅拉取 feed
 *   node daily-insights.js --generate-only  # 生成并发布 docs/
 *   node daily-insights.js --send-only      # 从 outputs 加载并发布 docs/（同 --reuse）
 *   node daily-insights.js --reuse          # 跳过 Feed+LLM，用今日 _insights.json 重渲染模板
 *   node daily-insights.js --preview        # 同 --reuse，并更新 docs/ + 创建 Buttondown 草稿
 *   node daily-insights.js --refresh        # 强制重拉 Feed + 重跑 LLM（忽略今日缓存）
 *   node daily-insights.js --send-buttondown # 通过 Buttondown API 向订阅者群发正文（推荐）
 *   node daily-insights.js --buttondown-draft # 同上，但只创建草稿（测试用）
 *   node daily-insights.js --send-newsletter  # 通过 SMTP 群发（备选）
 *   node daily-insights.js --legacy-smtp      # 同 --send-newsletter
 *   node daily-insights.js --dry-run          # 完整流程，不实际发信
 *
 * 环境变量:
 *   LLM_API_URL / LLM_API_KEY / LLM_MODEL   - 生成洞察（必填）
 *   SITE_URL                                - 站点根 URL（默认 https://cherrylin000.github.io/AI-news）
 *   TIME_ZONE / TZ                          - 发布日期时区（默认 Asia/Shanghai）
 *   BUTTONDOWN_API_KEY                      - --send-buttondown 时必填
 *   BUTTONDOWN_MODE                         - send（默认）或 draft
 *   SMTP_* / NEWSLETTER_RECIPIENTS          - --send-newsletter 时需要
 *
 * index.html 中 <!-- ai-news:dynamic-start/end --> 之间由脚本每日更新；
 * 订阅区（Buttondown 嵌入表单）在标记之外，需人工维护，脚本不会覆盖。
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

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseRecipients(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === 'string') return parseRecipientToken(item);
          if (item?.address) return { name: item.name || item.address, address: item.address };
          if (item?.email) return { name: item.name || item.email, address: item.email };
          return null;
        })
        .filter(Boolean);
    }
  } catch {
    // 普通逗号/换行列表会走下面的解析逻辑。
  }

  return raw
    .split(/[\n,;]+/)
    .map((token) => parseRecipientToken(token))
    .filter(Boolean);
}

function parseRecipientToken(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '');
    const address = match[2].trim();
    return { name: name || address, address };
  }
  return { name: trimmed, address: trimmed };
}

function formatMailbox(name, address) {
  const mailbox = String(address || '').trim();
  if (!mailbox) return '';
  const displayName = String(name || '').trim();
  if (!displayName) return mailbox;
  return `"${displayName.replace(/"/g, '\\"')}" <${mailbox}>`;
}

// ======================== 配置区 ========================

const CONFIG = {
  // Feed数据源URL
  feeds: {
    x: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
    podcasts: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
    blogs: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json',
  },

  // 📧 使用 --send-newsletter / --legacy-smtp 时群发，收件人来自 NEWSLETTER_RECIPIENTS
  recipients: parseRecipients(process.env.NEWSLETTER_RECIPIENTS || ''),

  // GitHub Pages：首页在仓库根 index.html；邮件/RSS 在 docs/ 避免冲突
  repoRoot: path.join(__dirname, '..'),
  assetsDir: path.join(__dirname, '..', 'docs'),
  assetsUrlPath: '/docs',
  siteUrl: (process.env.SITE_URL || 'https://cherrylin000.github.io/AI-news').replace(/\/$/, ''),
  timeZone: process.env.TIME_ZONE || process.env.TZ || 'Asia/Shanghai',
  feedMaxItems: 60,

  // 邮件主题模板
  emailSubject: (date) => `每日AI洞察 | ${date}`,

  // SMTP配置（通过环境变量或直接填写）
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseBoolean(process.env.SMTP_SECURE, parseInt(process.env.SMTP_PORT || '587') === 465),
    requireTLS: parseBoolean(process.env.SMTP_REQUIRE_TLS, true),
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },
  fromAddress: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  fromName: process.env.SMTP_FROM_NAME || 'AI洞察日报',
  replyTo: process.env.SMTP_REPLY_TO || '',

  // Buttondown API（--send-buttondown）
  buttondown: {
    apiKey: process.env.BUTTONDOWN_API_KEY || '',
    apiUrl: 'https://api.buttondown.com/v1/emails',
    mode: (process.env.BUTTONDOWN_MODE || 'send').toLowerCase(),
    username: process.env.BUTTONDOWN_USERNAME || 'cherrylin000',
    archiveUrl: (process.env.BUTTONDOWN_ARCHIVE_URL || '').replace(/\/$/, '') ||
      `https://buttondown.com/${process.env.BUTTONDOWN_USERNAME || 'cherrylin000'}/archive`,
    // naked = 不用 Buttondown 外层主题（Modern 会强制左对齐）；见 api-emails-template
    template: process.env.BUTTONDOWN_TEMPLATE || 'naked',
  },

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
async function callLLM(messages, temperature = 0.3, maxTokens = 8192) {
  if (!CONFIG.llm.apiKey) {
    throw new Error('未配置LLM_API_KEY，无法生成洞察。请设置环境变量 LLM_API_KEY');
  }

  const body = JSON.stringify({
    model: CONFIG.llm.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
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
            resolve({
              content: json.choices[0].message.content,
              finishReason: json.choices[0].finish_reason,
            });
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
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
6. 输出严格遵循JSON格式，不要输出markdown代码块
7. 每条 en_summary / cn_summary 控制在 80 字以内，takeaway 各要点保持简洁

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
        "url": "原文链接"
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

  const attempts = [
    { maxTokens: 8192, label: '首次' },
    { maxTokens: 16384, label: '加长输出重试' },
  ];

  let lastError;
  for (const attempt of attempts) {
    console.log(`🤖 LLM 请求（${attempt.label}，max_tokens=${attempt.maxTokens}）...`);
    const { content, finishReason } = await callLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 0.3, attempt.maxTokens);

    if (finishReason === 'length') {
      console.warn(`⚠️ LLM 输出可能被截断（finish_reason=length）`);
    }

    let jsonStr = content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const insights = normalizeInsightsShape(JSON.parse(jsonStr));
      console.log(
        `✅ 洞察生成完成: ${insights.insights.x.length}条X, ${insights.insights.podcasts.length}条播客, ${insights.insights.blogs.length}条博客`
      );
      return insights;
    } catch (e) {
      lastError = e;
      console.error(`❌ LLM输出JSON解析失败（${attempt.label}），原始输出前500字符:`);
      console.error(jsonStr.substring(0, 500));
      if (attempt !== attempts[attempts.length - 1]) {
        console.log('🔄 将用更大 max_tokens 重试...');
      }
    }
  }

  throw new Error(`LLM输出格式错误: ${lastError?.message || 'JSON 无法解析'}，请重试或调整 prompt`);
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

/** LLM 有时返回 {"1":{...},"2":{...}} 对象而非数组，统一转为数组供 HTML/MD 渲染 */
function normalizeInsightList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') {
    return Object.keys(value)
      .sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return String(a).localeCompare(String(b));
      })
      .map((k) => value[k])
      .filter(Boolean);
  }
  return [];
}

function normalizeInsightsShape(insights) {
  if (!insights || typeof insights !== 'object') return insights;
  if (!insights.insights || typeof insights.insights !== 'object') {
    insights.insights = { x: [], podcasts: [], blogs: [] };
    return insights;
  }
  insights.insights.x = normalizeInsightList(insights.insights.x);
  insights.insights.podcasts = normalizeInsightList(insights.insights.podcasts);
  insights.insights.blogs = normalizeInsightList(insights.insights.blogs);
  return insights;
}

// ======================== Markdown生成 ========================

function generateMarkdown(insights, date) {
  insights = normalizeInsightsShape(insights);
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

/** 与 GitHub Pages 首页 index.html 一致 */
const EMAIL_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans SC", sans-serif';
/** 用于 HTML style="" 属性（内部用单引号包字体名，避免属性断裂） */
const EMAIL_FONT_INLINE =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Noto Sans SC', sans-serif";
const EMAIL_LAYOUT_WIDTH = 720;
/** 邮件正文块级元素共用：流式宽度 + 强制换行（兼容 Buttondown 归档页窄容器） */
const EMAIL_WRAP_STYLE = 'word-wrap:break-word; overflow-wrap:break-word; word-break:break-word; max-width:100%; box-sizing:border-box;';

function getEmailResponsiveStyles() {
  return `<style type="text/css">
  html, body { width: 100% !important; margin: 0 !important; }
  .email-body { margin: 0; padding: 0; font-family: ${EMAIL_FONT_FAMILY}; background-color: #ffffff; color: #111827; text-align: center; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  .email-container { width: 100% !important; max-width: ${EMAIL_LAYOUT_WIDTH}px !important; border: 1px solid #e5e7eb; border-radius: 12px; text-align: left !important; box-sizing: border-box !important; overflow: visible !important; margin: 0 auto !important; }
  .email-content { text-align: left !important; max-width: 100% !important; box-sizing: border-box !important; }
  .email-h1 { margin: 0; font-size: 24px; color: #111827; line-height: 1.35; text-align: left; font-weight: 700; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  .email-subtitle { margin: 6px 0 0 0; color: #6b7280; font-size: 15px; line-height: 1.5; text-align: left; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  .email-h2 { margin: 0 0 14px 0; font-size: 17px; color: #6366f1; line-height: 1.4; text-align: left; font-weight: 600; padding-left: 14px; border-left: 4px solid #6366f1; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  .email-h2-warn { margin: 0 0 14px 0; font-size: 17px; color: #f59e0b; line-height: 1.4; text-align: left; font-weight: 600; }
  .email-h2-hot { margin: 0 0 14px 0; font-size: 18px; color: #dc2626; line-height: 1.4; text-align: left; font-weight: 600; }
  .email-h3 { margin: 14px 0 10px 0; font-size: 16px; color: #111827; line-height: 1.4; text-align: left; font-weight: 600; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  .email-text { margin: 0; color: #333333; font-size: 14px; line-height: 1.7; text-align: left; word-wrap: break-word !important; overflow-wrap: break-word !important; word-break: break-word !important; }
  .email-link { color: #6366f1; text-decoration: none; font-size: 13px; }
  .email-card { width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; }
  .email-card-inner { text-align: left; max-width: 100% !important; box-sizing: border-box !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  .email-takeaway-wrap { width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; }
  .email-takeaway-title { margin: 0; font-weight: 600; color: #991b1b; font-size: 17px; line-height: 1.4; text-align: left; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  .email-takeaway-block { width: 100% !important; max-width: 100% !important; margin-top: 10px; color: #333333; font-size: 14px; line-height: 1.7; text-align: left; box-sizing: border-box !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  @media only screen and (max-width: 620px) {
    .email-body { padding: 0 8px 12px !important; }
    .email-container { width: 100% !important; max-width: 100% !important; }
    .email-header { padding: 14px 12px !important; }
    .email-section { padding: 14px 12px !important; }
    .email-section-tight { padding: 0 12px 14px 12px !important; }
    .email-footer { padding: 12px !important; }
    .email-h1 { font-size: 20px !important; }
    .email-subtitle { font-size: 14px !important; }
    .email-h2 { font-size: 16px !important; padding-left: 10px !important; margin-bottom: 12px !important; }
    .email-h2-warn { font-size: 16px !important; }
    .email-h2-hot { font-size: 17px !important; }
    .email-h3 { font-size: 15px !important; margin: 12px 0 8px 0 !important; }
    .email-text { font-size: 13px !important; line-height: 1.65 !important; }
    .email-link { font-size: 12px !important; }
    .email-card { padding: 12px !important; }
    .email-takeaway-title { font-size: 15px !important; }
    .email-takeaway-block { font-size: 13px !important; }
    .email-takeaway-block td { padding: 6px !important; }
    .email-footer-text { font-size: 12px !important; }
  }
</style>`;
}

/** 粉色内容块：与 email-card 一样用 width=100% 表格，保证与 X/Twitter 卡片同宽 */
function appendTakeawayPinkBlock(parts, html, isFirst) {
  const marginTop = isFirst ? 'margin-top:0' : 'margin-top:10px';
  parts.push(`<table class="email-takeaway-block" width="100%" cellpadding="8" cellspacing="0" bgcolor="#fee2e2" style="${marginTop}; border-radius:4px; width:100%; max-width:100%; box-sizing:border-box;">
<tbody><tr><td style="color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${html}</td></tr></tbody></table>`);
}

function renderTakeawayLangBlocks(tw, lang) {
  const isEn = lang === 'en';
  const title = isEn ? tw.title_en : tw.title_cn;
  const overview = isEn ? tw.overview_en : tw.overview_cn;
  const keyPoints = isEn ? tw.key_points_en : tw.key_points_cn;
  const implications = isEn ? tw.implications_en : tw.implications_cn;
  const bottomLine = isEn ? tw.bottom_line_en : tw.bottom_line_cn;
  const labels = isEn
    ? { key: 'Key Points:', impl: 'Implications:', bottom: 'Bottom line:' }
    : { key: '关键要点：', impl: '启示：', bottom: '总结：' };

  const parts = [];
  const titleMargin = isEn ? 'margin:0' : 'margin-top:14px';
  parts.push(`<p class="email-takeaway-title" style="${titleMargin}; font-weight:600; color:#991b1b; font-size:17px; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(title)}</p>`);

  let isFirst = true;
  if (overview) {
    appendTakeawayPinkBlock(parts, escapeHtml(overview), isFirst);
    isFirst = false;
  }
  if (keyPoints?.length) {
    let html = `<strong>${labels.key}</strong><br><br>`;
    keyPoints.forEach((p, i) => {
      html += `<strong>${i + 1}. ${escapeHtml(p.title)}:</strong> ${escapeHtml(p.content)}<br>`;
    });
    appendTakeawayPinkBlock(parts, html, isFirst);
    isFirst = false;
  }
  if (implications?.length) {
    let html = `<strong>${labels.impl}</strong><br><br>`;
    implications.forEach((p, i) => {
      html += `<strong>${i + 1}. ${escapeHtml(p.title)}:</strong> ${escapeHtml(p.content)}<br>`;
    });
    appendTakeawayPinkBlock(parts, html, isFirst);
    isFirst = false;
  }
  if (bottomLine) {
    const html = isEn
      ? `<strong>${labels.bottom}</strong> ${escapeHtml(bottomLine)}`
      : `<strong>${labels.bottom}</strong>${escapeHtml(bottomLine)}`;
    appendTakeawayPinkBlock(parts, html, isFirst);
  }
  return parts.join('');
}

function generateHTML(insights, date) {
  insights = normalizeInsightsShape(insights);
  let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${getEmailResponsiveStyles()}
</head>
<body class="email-body" style="margin:0; padding:0; width:100%; font-family:${EMAIL_FONT_INLINE}; background-color:#ffffff; color:#111827; text-align:center;">
<!--[if mso]><table width="${EMAIL_LAYOUT_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table class="email-container" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" role="presentation" style="width:100%; max-width:${EMAIL_LAYOUT_WIDTH}px; margin:0 auto; border:1px solid #e5e7eb; border-radius:12px; text-align:left; box-sizing:border-box;">
<tbody>

<!-- Header -->
<tr>
<td class="email-header email-content" bgcolor="#f8fafc" style="border-bottom:3px solid #6366f1; padding:16px 20px; text-align:left; ${EMAIL_WRAP_STYLE}">
<h1 class="email-h1" style="margin:0; font-size:24px; color:#111827; line-height:1.35; text-align:left; ${EMAIL_WRAP_STYLE}">📅 ${escapeHtml(date)} | ${escapeHtml(insights.title_cn)}</h1>
<p class="email-subtitle" style="margin:6px 0 0 0; color:#6b7280; font-size:15px; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(insights.title_en)}</p>
</td>
</tr>`;

  // X / Twitter
  const xItems = insights.insights?.x || [];
  if (xItems.length > 0) {
    html += `
<tr>
<td class="email-section email-content" style="padding:16px 20px; text-align:left;">
<h2 class="email-h2" style="margin:0 0 14px 0; font-size:17px; color:#6366f1; text-align:left; padding-left:14px; border-left:4px solid #6366f1;">📱 X / Twitter</h2>`;
    for (const item of xItems) {
      html += `
<h3 class="email-h3" style="margin:14px 0 10px 0; font-size:16px; color:#111827; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.builder)} (${escapeHtml(item.role)})</h3>
<table class="email-card" width="100%" cellpadding="14" cellspacing="0" bgcolor="#f9fafb" style="border:1px solid #e5e7eb; border-radius:8px; width:100%; max-width:100%; box-sizing:border-box;">
<tbody><tr><td style="text-align:left; ${EMAIL_WRAP_STYLE}">
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0; width:100%; max-width:100%;">
<tbody><tr><td class="email-card-inner" style="text-align:left; ${EMAIL_WRAP_STYLE}">
<p class="email-text" style="margin:0; color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.en_summary)}</p>
</td></tr></tbody>
</table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px; width:100%; max-width:100%;">
<tbody><tr><td class="email-card-inner" style="text-align:left; ${EMAIL_WRAP_STYLE}">
<p class="email-text" style="margin:0; color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.cn_summary)}</p>
</td></tr></tbody>
</table>
<p style="margin:10px 0 0 0; text-align:left;"><a class="email-link" href="${escapeHtml(item.url)}" style="color:#6366f1; text-decoration:none; font-size:13px;">🔗 原文链接</a></p>
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
<td class="email-section-tight email-content" style="padding:0 20px 20px 20px; text-align:left;">
<h2 class="email-h2" style="margin:0 0 14px 0; font-size:17px; color:#6366f1; text-align:left; padding-left:14px; border-left:4px solid #6366f1;">🎙️ Podcasts</h2>`;
    for (const item of podItems) {
      html += `
<h3 class="email-h3" style="margin:14px 0 10px 0; font-size:16px; color:#111827; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.name)}: ${escapeHtml(item.episode)}</h3>
<table class="email-card" width="100%" cellpadding="14" cellspacing="0" bgcolor="#f9fafb" style="border:1px solid #e5e7eb; border-radius:8px; width:100%; max-width:100%; box-sizing:border-box;">
<tbody><tr><td style="text-align:left; ${EMAIL_WRAP_STYLE}">
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0; width:100%; max-width:100%;">
<tbody><tr><td class="email-card-inner" style="text-align:left; ${EMAIL_WRAP_STYLE}">
<p class="email-text" style="margin:0; color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.en_summary)}</p>
</td></tr></tbody>
</table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px; width:100%; max-width:100%;">
<tbody><tr><td class="email-card-inner" style="text-align:left; ${EMAIL_WRAP_STYLE}">
<p class="email-text" style="margin:0; color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.cn_summary)}</p>
</td></tr></tbody>
</table>
<p style="margin:10px 0 0 0; text-align:left;"><a class="email-link" href="${escapeHtml(item.url)}" style="color:#6366f1; text-decoration:none; font-size:13px;">🔗 原文链接</a></p>
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
<td class="email-section-tight email-content" style="padding:0 20px 20px 20px; text-align:left;">
<h2 class="email-h2" style="margin:0 0 14px 0; font-size:17px; color:#6366f1; text-align:left; padding-left:14px; border-left:4px solid #6366f1;">📝 Official Blogs</h2>`;
    for (const item of blogItems) {
      html += `
<h3 class="email-h3" style="margin:14px 0 10px 0; font-size:16px; color:#111827; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.name)}: ${escapeHtml(item.title)}</h3>
<table class="email-card" width="100%" cellpadding="14" cellspacing="0" bgcolor="#f9fafb" style="border:1px solid #e5e7eb; border-radius:8px; width:100%; max-width:100%; box-sizing:border-box;">
<tbody><tr><td style="text-align:left; ${EMAIL_WRAP_STYLE}">
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0; width:100%; max-width:100%;">
<tbody><tr><td class="email-card-inner" style="text-align:left; ${EMAIL_WRAP_STYLE}">
<p class="email-text" style="margin:0; color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.en_summary)}</p>
</td></tr></tbody>
</table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px; width:100%; max-width:100%;">
<tbody><tr><td class="email-card-inner" style="text-align:left; ${EMAIL_WRAP_STYLE}">
<p class="email-text" style="margin:0; color:#333333; font-size:14px; line-height:1.7; text-align:left; ${EMAIL_WRAP_STYLE}">${escapeHtml(item.cn_summary)}</p>
</td></tr></tbody>
</table>
<p style="margin:10px 0 0 0; text-align:left;"><a class="email-link" href="${escapeHtml(item.url)}" style="color:#6366f1; text-decoration:none; font-size:13px;">🔗 原文链接</a></p>
</td></tr></tbody></table>`;
    }
    html += `
</td>
</tr>`;
  }

  // Top Takeaway（保留红框+粉色块；外层 table width=100% 与 X/Twitter email-card 同宽）
  const tw = insights.takeaway;
  if (tw) {
    html += `
<tr>
<td class="email-section-tight email-content" style="padding:0 20px 20px 20px; text-align:left;">
<h2 class="email-h2-hot" style="margin:0 0 14px 0; font-size:18px; color:#dc2626; text-align:left;">🔥 Today's Top Takeaway</h2>
<table class="email-takeaway-wrap" width="100%" cellpadding="14" cellspacing="0" bgcolor="#fef2f2" style="border:2px solid #dc2626; border-radius:8px; width:100%; max-width:100%; box-sizing:border-box;">
<tbody><tr><td style="text-align:left; ${EMAIL_WRAP_STYLE}">
${renderTakeawayLangBlocks(tw, 'en')}
${renderTakeawayLangBlocks(tw, 'cn')}
</td></tr></tbody></table>
</td>
</tr>`;
  }

  // Footer
  const totalCount = xItems.length + podItems.length + blogItems.length;
  html += `
<tr>
<td class="email-footer email-content" style="padding:16px; text-align:left; border-top:1px solid #e5e7eb;">
<p class="email-footer-text" style="margin:0; color:#9ca3af; font-size:13px;">共${totalCount}条高价值洞察</p>
</td>
</tr>

</tbody></table>
<!--[if mso]></td></tr></table><![endif]-->
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

/** CDATA 安全包裹（用于 RSS 内嵌 HTML 内容） */
function wrapCdata(str) {
  if (!str) return '';
  return String(str).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

/** RSS content:encoded 应使用 HTML 片段，避免阅读器误判完整文档为无效内容。 */
function toFeedHtmlFragment(html) {
  if (!html) return '';
  const bodyMatch = String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1].trim() : String(html).trim();
}

// ======================== 站点发布（GitHub Pages + RSS） ========================

function toRssPubDate(date = new Date()) {
  return date.toUTCString();
}

function buildRssSummary(insights, date) {
  insights = normalizeInsightsShape(insights);
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
      const feedHtml = toFeedHtmlFragment(item.contentHtml || '');
      const encodedBlock = feedHtml
        ? `\n      <content:encoded><![CDATA[${wrapCdata(feedHtml)}]]></content:encoded>`
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
    <title>每日AI洞察</title>
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

const LANDING_DYNAMIC_START = '<!-- ai-news:dynamic-start -->';
const LANDING_DYNAMIC_END = '<!-- ai-news:dynamic-end -->';

function getDynamicLandingBody(_insights, date) {
  const archiveUrl = CONFIG.buttondown.archiveUrl;
  return `    <header>
      <h1>📅 每日AI洞察</h1>
      <p class="header-intro">从 X、播客、官方博客等渠道追踪 AI 领域的顶级建设者——研究人员、创始人、产品经理和实际从事建设工作的一线工程师——并提供他们观点的精选总结。每日一封中英双语邮件，面向想订阅、阅读、了解 AI 最新趋势的读者。</p>
      <p class="header-intro">新闻来源于 GitHub 作者 <a class="header-plain-link" href="https://github.com/zarazhangrui" target="_blank" rel="noopener">Zara Zhang</a> 的开源项目 <a class="header-plain-link" href="https://github.com/zarazhangrui/follow-builders" target="_blank" rel="noopener">follow-builders</a>，她提出了「Follow builders, not influencers」的理念：关注那些构建产品并拥有原创观点的人，而非那些只会复述信息的自媒体网红。</p>
      <p class="header-meta">下方为今日邮件预览；订阅后每天早上自动推送中英双语AI洞察摘要，访问原文链接需挂🪜。</p>
      <p class="header-meta">回顾往日内容：点击查看<a class="header-plain-link" href="${escapeHtml(archiveUrl)}" target="_blank" rel="noopener">往期 AI 洞察</a></p>
      <p class="header-meta">订阅每日推送：点击开始<a class="header-plain-link" href="#subscribe">邮件订阅</a></p>
    </header>

    <section>
      <h2>📧 今日邮件预览</h2>
      <iframe class="preview-frame" src="docs/latest.html" title="今日洞察邮件预览"></iframe>
      <p style="margin:12px 0 0;font-size:0.85rem;"><a href="docs/latest.html" target="_blank" rel="noopener">在新标签页打开完整预览</a>
        · <a href="docs/archive/${date}.html" target="_blank" rel="noopener">归档链接</a></p>
    </section>`;
}

function findSubscribePreserveStart(html, headerIdx, footerIdx) {
  const markers = [
    html.indexOf('<section id="subscribe">'),
    html.indexOf('class="buttondown-subscribe"'),
    html.indexOf('api/emails/embed-subscribe/'),
    html.indexOf('class="followit--follow-form-container"'),
    html.indexOf('class="subscribe-placeholder"'),
  ].filter((i) => i >= 0 && i < footerIdx);
  if (markers.length === 0) return footerIdx;

  const idx = Math.min(...markers);
  const styleBefore = html.lastIndexOf('<style>', idx);
  if (styleBefore > headerIdx && html.slice(styleBefore, idx).includes('followit')) {
    return styleBefore;
  }
  return idx;
}

const LANDING_TITLE = '每日AI洞察';
const LANDING_DESCRIPTION =
  '从 X、播客、官方博客追踪 AI 领域顶级建设者，每日一封中英双语邮件，精选总结研究人员、创始人、产品经理与一线工程师的原创观点。';

function getLandingHeadMeta() {
  const ogImage = `${CONFIG.siteUrl}/icon.svg`;
  return `  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <meta name="description" content="${escapeHtml(LANDING_DESCRIPTION)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(LANDING_TITLE)}">
  <meta property="og:description" content="${escapeHtml(LANDING_DESCRIPTION)}">
  <meta property="og:url" content="${escapeHtml(`${CONFIG.siteUrl}/`)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="1024">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(LANDING_TITLE)}">
  <meta name="twitter:description" content="${escapeHtml(LANDING_DESCRIPTION)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">`;
}

function updateLandingPage(existingHtml, insights, date) {
  const dynamicBody = getDynamicLandingBody(insights, date);
  let html = existingHtml;

  if (html.includes(LANDING_DYNAMIC_START) && html.includes(LANDING_DYNAMIC_END)) {
    const pattern = new RegExp(
      `${LANDING_DYNAMIC_START}[\\s\\S]*?${LANDING_DYNAMIC_END}`
    );
    return html.replace(pattern, `${LANDING_DYNAMIC_START}\n${dynamicBody}\n    ${LANDING_DYNAMIC_END}`);
  }

  const headerIdx = html.indexOf('<header>');
  const footerIdx = html.indexOf('<footer>');
  if (headerIdx === -1 || footerIdx === -1 || headerIdx >= footerIdx) {
    console.warn('⚠️ index.html 结构异常，将整页重写（订阅区需手动恢复）');
    return generateLandingPage(insights, date);
  }

  const preserveStart = findSubscribePreserveStart(html, headerIdx, footerIdx);
  const headPart = html.slice(0, headerIdx);
  const preserved = html.slice(preserveStart);
  console.log('ℹ️ 已为 index.html 注入动态区标记，订阅区保持不变');
  return `${headPart}${LANDING_DYNAMIC_START}\n${dynamicBody}\n    ${LANDING_DYNAMIC_END}\n\n${preserved}`;
}

function generateLandingPage(insights, date) {
  const dynamicBody = getDynamicLandingBody(insights, date);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>每日AI洞察</title>
${getLandingHeadMeta()}
  <link rel="alternate" type="application/rss+xml" title="每日AI洞察" href="${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/feed.xml">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans SC", sans-serif; background: #f1f5f9; color: #111827; }
    .wrap { max-width: 800px; margin: 0 auto; padding: 24px 16px 48px; }
    header { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 20px; border-bottom: 3px solid #6366f1; }
    header h1 { margin: 0 0 8px; font-size: 1.5rem; }
    header p.header-intro { margin: 12px 0 0; color: #111827; font-size: 0.95rem; line-height: 1.65; }
    header p.header-meta { margin: 16px 0 0; color: #6b7280; font-size: 0.85rem; line-height: 1.65; }
    header a.header-plain-link { color: #6366f1; text-decoration: underline; font-weight: 400; }
    header a.header-plain-link:hover { color: #4f46e5; }
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
    ${LANDING_DYNAMIC_START}
${dynamicBody}
    ${LANDING_DYNAMIC_END}

    <section id="subscribe" class="buttondown-subscribe" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:20px;">
      <h2 style="margin:0 0 16px;font-size:1.1rem;color:#6366f1;">📬 邮件订阅</h2>
      <p style="margin:0 0 16px;color:#6b7280;font-size:0.9rem;">将 YOUR_BUTTONDOWN_USERNAME 替换为你在 Buttondown 的用户名（见 docs/BUTTONDOWN.md）。</p>
      <form action="https://buttondown.com/api/emails/embed-subscribe/YOUR_BUTTONDOWN_USERNAME" method="post" style="display:flex;flex-direction:column;gap:10px;width:100%;">
        <input type="email" name="email" placeholder="输入你的邮箱地址" required style="width:100%;height:40px;border:1px solid #e5e7eb;border-radius:8px;padding:0 12px;font-size:14px;">
        <input type="hidden" name="embed" value="1">
        <button type="submit" style="width:100%;height:40px;border:0;border-radius:8px;background:#6366f1;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">订阅</button>
      </form>
    </section>

    <footer>
      <p><a href="docs/feed.xml">RSS Feed</a> · 由 <a href="https://github.com/cherrylin000/AI-news">AI-news</a> 自动生成</p>
    </footer>
  </div>
</body>
</html>
`;
}

function writeLandingPage(insights, date) {
  const indexPath = path.join(CONFIG.repoRoot, 'index.html');
  const html = fs.existsSync(indexPath)
    ? updateLandingPage(fs.readFileSync(indexPath, 'utf-8'), insights, date)
    : generateLandingPage(insights, date);
  fs.writeFileSync(indexPath, html, 'utf-8');
}

function publishSite(insights, date, htmlContent) {
  const archiveDir = path.join(CONFIG.assetsDir, 'archive');
  ensureDir(CONFIG.assetsDir);
  ensureDir(archiveDir);

  const latestPath = path.join(CONFIG.assetsDir, 'latest.html');
  const archivePath = path.join(archiveDir, `${date}.html`);
  const feedPath = path.join(CONFIG.assetsDir, 'feed.xml');
  const legacyIndexPath = path.join(CONFIG.assetsDir, 'index.html');

  fs.writeFileSync(latestPath, htmlContent, 'utf-8');
  fs.writeFileSync(archivePath, htmlContent, 'utf-8');
  writeLandingPage(insights, date);
  fs.writeFileSync(path.join(CONFIG.repoRoot, '.nojekyll'), '', 'utf-8');
  if (fs.existsSync(legacyIndexPath)) fs.unlinkSync(legacyIndexPath);

  const archiveLink = `${CONFIG.siteUrl}${CONFIG.assetsUrlPath}/archive/${date}.html`;
  const title = `每日AI洞察 | ${date}`;
  const summary = buildRssSummary(insights, date);
  // description：RSS 摘要；contentHtml：与 latest.html 相同的完整邮件 HTML
  const descriptionHtml = `<p>${escapeHtml(summary).replace(/&lt;br&gt;/g, '<br>')}</p><p><a href="${archiveLink}">归档链接</a></p>`;

  let items = loadFeedItems().filter((item) => item.date !== date);
  items.unshift({
    date,
    title,
    link: archiveLink,
    guid: archiveLink,
    pubDate: toRssPubDate(),
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

// ======================== Buttondown API（--send-buttondown） ========================

function getButtondownStatePath() {
  return path.join(CONFIG.assetsDir, 'buttondown-state.json');
}

function loadButtondownState() {
  const statePath = getButtondownStatePath();
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveButtondownState(state) {
  ensureDir(CONFIG.assetsDir);
  fs.writeFileSync(getButtondownStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function prepareButtondownBody(htmlContent) {
  let html = htmlContent.trim();
  const template = CONFIG.buttondown.template || 'naked';
  // naked 模板已是完整 HTML，勿加 fancy 注释（否则 Buttondown 会用左对齐的 Fancy 容器包裹）
  if (template !== 'naked' && !html.includes('buttondown-editor-mode:')) {
    html = `<!-- buttondown-editor-mode: fancy -->\n${html}`;
  }
  // naked 模板要求包含退订链接
  if (!html.includes('{{ unsubscribe_url }}')) {
    const unsub =
      '<p style="margin:16px 0 0; text-align:center; color:#9ca3af; font-size:12px;">' +
      '<a href="{{ unsubscribe_url }}" style="color:#6366f1; text-decoration:none;">退订此邮件</a></p>';
    html = html.replace(/<\/body>\s*<\/html>\s*$/i, `${unsub}\n</body></html>`);
  }
  return html;
}

function postButtondownEmail(payload) {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.buttondown.apiUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: `Token ${CONFIG.buttondown.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Buttondown-Live-Dangerously': 'true',
        },
        timeout: 90000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // keep raw string
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const detail = typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
          reject(new Error(`Buttondown API ${res.statusCode}: ${detail}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Buttondown API 请求超时')));
    req.write(data);
    req.end();
  });
}

async function sendViaButtondown(htmlContent, date, options = {}) {
  if (!CONFIG.buttondown.apiKey) {
    console.error('❌ 未配置 BUTTONDOWN_API_KEY');
    console.log('💡 在 Buttondown → Settings → API 创建密钥，写入 .env 或 GitHub Secrets');
    return false;
  }

  const asDraft = options.draft || CONFIG.buttondown.mode === 'draft';
  const subject = CONFIG.emailSubject(date);
  const state = loadButtondownState();

  if (!options.force && state.lastSentDate === date && !asDraft) {
    console.log(`\n📬 Buttondown：${date} 已发送过，跳过（emailId: ${state.emailId || '未知'}）`);
    console.log('   若需重发: node daily-insights.js --send-buttondown --force-buttondown');
    return true;
  }

  const status = asDraft ? 'draft' : 'about_to_send';
  const template = CONFIG.buttondown.template || 'naked';
  console.log(`\n📬 Buttondown：创建邮件（status=${status}, template=${template}）`);
  console.log(`   主题: ${subject}`);

  try {
    const response = await postButtondownEmail({
      subject,
      body: prepareButtondownBody(htmlContent),
      status,
      template,
    });

    const emailId = response.id || response.email_id || '';
    const archiveUrl = response.absolute_url || response.archive_url || '';

    if (asDraft) {
      console.log('   ✅ 草稿已创建（未发给订阅者）');
      if (archiveUrl) console.log(`   预览: ${archiveUrl}`);
      else if (emailId) console.log(`   邮件 ID: ${emailId}`);
      return true;
    }

    saveButtondownState({
      lastSentDate: date,
      emailId,
      subject,
      sentAt: new Date().toISOString(),
      archiveUrl,
    });

    console.log('   ✅ 已提交发送（about_to_send），订阅者将收到完整 HTML 正文');
    if (archiveUrl) console.log(`   归档: ${archiveUrl}`);
    return true;
  } catch (err) {
    console.error(`   ❌ Buttondown 失败: ${err.message}`);
    return false;
  }
}

// ======================== 邮件发送（--send-newsletter / SMTP） ========================

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
  const subject = CONFIG.emailSubject(date);
  const from = formatMailbox(CONFIG.fromName, CONFIG.fromAddress || CONFIG.smtp.auth.user);

  console.log(`📧 开始发送邮件，共${CONFIG.recipients.length}位收件人...`);
  console.log(`📧 主题: ${subject}`);
  console.log(`📧 发件人: ${from}`);

  const results = [];
  for (let i = 0; i < CONFIG.recipients.length; i++) {
    const recipient = CONFIG.recipients[i];
    console.log(`📧 [${i + 1}/${CONFIG.recipients.length}] 发送至: ${recipient.name} <${recipient.address}>`);

    try {
      const info = await transporter.sendMail({
        from,
        to: `"${recipient.name}" <${recipient.address}>`,
        replyTo: CONFIG.replyTo || undefined,
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

function getTodayInsightsPath(outputDir, date) {
  return path.join(outputDir, `${date}_insights.json`);
}

function loadTodayInsights(outputDir, date) {
  const jsonPath = getTodayInsightsPath(outputDir, date);
  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ 未找到今日洞察缓存: ${jsonPath}`);
    console.log('💡 请先完整跑一遍: node daily-insights.js');
    console.log('   或强制重拉 Feed: node daily-insights.js --refresh');
    process.exit(1);
  }
  const insights = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log(`📂 复用今日缓存（跳过 Feed + LLM）: ${jsonPath}`);
  return insights;
}

async function main() {
  const args = process.argv.slice(2);
  const fetchOnly = args.includes('--fetch-only');
  const generateOnly = args.includes('--generate-only');
  const preview = args.includes('--preview');
  const forceRefresh = args.includes('--refresh') || args.includes('--force-refresh');
  const reuse =
    !forceRefresh &&
    (args.includes('--send-only') || args.includes('--reuse') || preview);
  const dryRun = args.includes('--dry-run');
  const legacySmtp = args.includes('--legacy-smtp');
  const sendNewsletter = args.includes('--send-newsletter') || legacySmtp;
  const buttondownDraft = args.includes('--buttondown-draft') || preview;
  const forceButtondown = args.includes('--force-buttondown') || preview;
  const sendButtondown =
    args.includes('--send-buttondown') || buttondownDraft;

  const today = formatDate(new Date());
  const outputDir = path.join(CONFIG.outputBaseDir, today.substring(0, 4), today.substring(5, 7));
  ensureDir(outputDir);

  console.log(`\n🚀 每日AI洞察 - ${today}`);
  console.log(`🕒 发布日期时区: ${CONFIG.timeZone}`);
  console.log(`📁 输出目录: ${outputDir}`);
  if (reuse) console.log('♻️  模式: 复用今日 insights 缓存');
  if (preview) console.log('👀 模式: 预览（重渲染 + 更新 docs + Buttondown 草稿）');
  if (forceRefresh) console.log('🔄 模式: 强制刷新 Feed + LLM');
  console.log('');

  let feeds, insights, mdContent, htmlContent;

  // Step 1: 拉取Feed（--reuse / --preview 时跳过）
  if (!reuse) {
    feeds = await fetchFeeds();
  }

  if (fetchOnly) {
    console.log('\n✅ --fetch-only 模式，仅拉取feed，流程结束');
    return;
  }

  // Step 2: 筛选 + AI生成洞察（复用模式从 JSON 加载）
  if (!reuse) {
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
    insights = loadTodayInsights(outputDir, today);
    mdContent = generateMarkdown(insights, today);
    htmlContent = generateHTML(insights, today);
    console.log('📄 已按当前邮件模板重新生成 MD/HTML');
  }

  // 发布 GitHub Pages 站点与 RSS（有洞察数据时）
  if (insights && htmlContent) {
    publishSite(insights, today, htmlContent);
  }

  if (generateOnly) {
    console.log('\n✅ --generate-only 完成（已更新 docs/）');
    if (preview) {
      console.log('💡 --preview 通常无需再加 --generate-only；若要仅更新本站预览可用: --reuse --generate-only');
    }
    return;
  }

  if (dryRun) {
    console.log('\n🏃 --dry-run 模式');
    if (sendButtondown) {
      console.log(`📬 若启用 Buttondown，将${buttondownDraft ? '创建草稿' : '群发'}: ${CONFIG.emailSubject(today)}`);
    }
    if (sendNewsletter) {
      console.log(`📧 若启用 SMTP，将发送给 ${CONFIG.recipients.length} 位收件人:`);
      CONFIG.recipients.forEach((r) => console.log(`   - ${r.name} <${r.address}>`));
    }
    if (!sendButtondown && !sendNewsletter) {
      console.log('📬 默认不发邮件。');
    }
    return;
  }

  if (sendButtondown) {
    const ok = await sendViaButtondown(htmlContent, today, {
      draft: buttondownDraft,
      force: forceButtondown,
    });
    if (!ok) process.exit(1);
  } else if (sendNewsletter) {
    const hasAnyNewsletterConfig = CONFIG.recipients.length > 0 || CONFIG.smtp.host || CONFIG.smtp.auth.user || CONFIG.smtp.auth.pass;
    if (!hasAnyNewsletterConfig) {
      console.log('\n📬 未配置 SMTP/NEWSLETTER_RECIPIENTS，跳过 SMTP 群发。');
      return;
    }
    if (CONFIG.recipients.length === 0) {
      console.error('❌ --send-newsletter 需要设置 NEWSLETTER_RECIPIENTS');
      process.exit(1);
    }
    const ok = await sendEmails(htmlContent, mdContent, today, insights.title_cn || insights.title_en);
    if (!ok) process.exit(1);
  } else {
    console.log('\n📬 已跳过邮件推送。');
    console.log('   Buttondown: node daily-insights.js --send-buttondown');
    console.log('   SMTP: node daily-insights.js --send-newsletter');
  }

  console.log('\n✅ 全部流程完成！');
}

// 执行
main().catch((err) => {
  console.error('\n❌ 执行失败:', err.message);
  process.exit(1);
});
