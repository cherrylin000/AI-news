#!/usr/bin/env node
/** 从 docs/archive/YYYY-MM-DD.html 反解析 insights JSON，供 --reuse 重渲染 */
const fs = require('fs');
const path = require('path');

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n');
}

function stripTags(s) {
  return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseArchiveHtml(html, date) {
  const h1 = html.match(/<h1[^>]*>\s*📅\s*[\d-]+\s*\|\s*([^<]+)/i);
  const subtitle = html.match(/<p class="email-subtitle"[^>]*>([\s\S]*?)<\/p>/i);
  const insights = {
    title_cn: stripTags(h1?.[1]),
    title_en: stripTags(subtitle?.[1]),
    insights: { x: [], podcasts: [], blogs: [] },
    takeaway: null,
  };

  const sectionMap = {
    'X / Twitter': 'x',
    Podcasts: 'podcasts',
    'Official Blogs': 'blogs',
  };

  const sections = html.split(/<h2[^>]*>\s*[^<]*?\s([^<]+)<\/h2>/i);
  for (let i = 1; i < sections.length; i += 2) {
    const label = stripTags(sections[i]).replace(/^[^\w]+/, '').trim();
    const body = sections[i + 1] || '';
    const key = sectionMap[label];
    if (!key) continue;

    const blocks = body.split(/<h3 class="email-h3"[^>]*>/i).slice(1);
    for (const block of blocks) {
      const titleEnd = block.indexOf('</h3>');
      if (titleEnd < 0) continue;
      const titleRaw = stripTags(block.slice(0, titleEnd));
      const texts = [...block.matchAll(/<p class="email-text"[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
        stripTags(m[1])
      );
      const link = block.match(/href="([^"]+)"/i)?.[1] || '';
      if (texts.length < 2) continue;

      if (key === 'x') {
        const m = titleRaw.match(/^(.+?)\s*\((.+)\)$/);
        insights.insights.x.push({
          builder: m?.[1] || titleRaw,
          role: m?.[2] || '',
          en_summary: texts[0],
          cn_summary: texts[1],
          url: link,
        });
      } else if (key === 'podcasts') {
        const idx = titleRaw.indexOf(': ');
        insights.insights.podcasts.push({
          name: idx > 0 ? titleRaw.slice(0, idx) : titleRaw,
          episode: idx > 0 ? titleRaw.slice(idx + 2) : '',
          en_summary: texts[0],
          cn_summary: texts[1],
          url: link,
        });
      } else {
        const idx = titleRaw.indexOf(': ');
        insights.insights.blogs.push({
          name: idx > 0 ? titleRaw.slice(0, idx) : titleRaw,
          title: idx > 0 ? titleRaw.slice(idx + 2) : '',
          en_summary: texts[0],
          cn_summary: texts[1],
          url: link,
        });
      }
    }
  }

  const takeawayMatch = html.match(/<h2 class="email-h2-hot"[\s\S]*?<table class="email-takeaway-wrap"[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
  if (takeawayMatch) {
    const twHtml = takeawayMatch[1];
    const titles = [...twHtml.matchAll(/<p class="email-takeaway-title"[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
      stripTags(m[1])
    );
    const blocks = [...twHtml.matchAll(/<table class="email-takeaway-block"[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (m) => stripTags(m[1])
    );
    insights.takeaway = {
      title_en: titles[0] || '',
      title_cn: titles[1] || titles[0] || '',
      overview_en: blocks[0] || '',
      overview_cn: blocks.find((b, i) => i > 0 && /[\u4e00-\u9fff]/.test(b)) || blocks[1] || '',
      key_points_en: [],
      key_points_cn: [],
      implications_en: [],
      implications_cn: [],
      bottom_line_en: '',
      bottom_line_cn: '',
    };
  }

  if (!insights.title_cn) {
    throw new Error(`无法从归档解析 ${date} 的标题`);
  }
  return insights;
}

function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const archivePath = path.join(__dirname, '..', 'docs', 'archive', `${date}.html`);
  if (!fs.existsSync(archivePath)) {
    console.error(`❌ 归档不存在: ${archivePath}`);
    process.exit(1);
  }
  const html = fs.readFileSync(archivePath, 'utf-8');
  const insights = parseArchiveHtml(html, date);
  const outDir = path.join(__dirname, '..', 'outputs', '每日洞察', date.slice(0, 4), date.slice(5, 7));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}_insights.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(insights, null, 2)}\n`, 'utf-8');
  console.log(`✅ 已写入 ${outPath}`);
  console.log(`   X: ${insights.insights.x.length}, Podcasts: ${insights.insights.podcasts.length}, Blogs: ${insights.insights.blogs.length}`);
}

main();
