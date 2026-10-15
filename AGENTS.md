# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **single Node.js CLI tool** (`scripts/daily-insights.js`), not a web service. It
fetches the upstream `follow-builders` feeds, asks an LLM to produce bilingual (中/英) insights, then
renders a static GitHub Pages site (`index.html`, `docs/latest.html`, `docs/feed.xml`,
`docs/archive/<date>.html`) and optionally emails subscribers via Buttondown. The daily run is driven
by `.github/workflows/daily-insights.yml` (Node 22). Command reference lives in `scripts/README.md`
and `README.md` (开发者指南); secrets in `docs/SECRETS.md`.

Non-obvious things to know:

- **Dependencies install under `scripts/`** (`scripts/node_modules`, gitignored). The only runtime dep
  is `nodemailer` (used solely by `--send-newsletter`/`--legacy-smtp`). Run commands from `scripts/`.
- **No test suite and no lint config exist.** Use `node --check daily-insights.js` as a syntax/sanity
  check. Don't invent a lint/test setup.
- **Full pipeline needs secrets + network.** `node daily-insights.js` (and `--generate-only` without
  `--reuse`) calls the LLM and will fail with `未配置LLM_API_KEY` unless `LLM_API_KEY` (plus
  `LLM_API_URL`, `LLM_MODEL`) is set; sending needs `BUTTONDOWN_API_KEY`. Feed fetch hits
  `raw.githubusercontent.com/zarazhangrui/follow-builders`.
- **To exercise the core render/publish flow WITHOUT an LLM key:** drop a today's insights cache at
  `outputs/每日洞察/YYYY/MM/YYYY-MM-DD_insights.json` (schema = the JSON in `generateInsights`'s
  system prompt) and run `node daily-insights.js --reuse --generate-only`. `outputs/` is gitignored.
  `--fetch-only` works on its own (network only) to verify upstream feeds.
- **The "today" date is computed in `Asia/Shanghai` time** (overridable via `TZ`/`TIME_ZONE`), so the
  `--reuse` cache path must use the Shanghai date, which can differ from UTC.
- **`--generate-only` rewrites tracked files**: `docs/latest.html`, `docs/feed.xml`,
  `docs/feed-items.json`, the dynamic region of `index.html`, and creates `docs/archive/<date>.html`.
  When running it just to test rendering, `git checkout`/`rm` those changes afterward so test renders
  aren't committed.
- **Preview the static output** by serving the repo root over HTTP (e.g. `python3 -m http.server`) and
  opening `/docs/latest.html` and `/index.html`; relative asset paths (`docs/`, `icon.svg`) require a
  server rather than `file://`.
