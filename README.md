# kc-sand

Small GitHub Actions scraper for Arab News:

- `https://www.arabnews.com/videos`: latest 3 video items
- `https://www.arabnews.com/`: current homepage `Top Headlines`

The scraper uses Playwright instead of `curl`/`fetch` because Arab News currently returns a Cloudflare challenge to simple HTTP clients. If GitHub-hosted runners are challenged too, set these repository secrets and rerun the workflow:

- `PLAYWRIGHT_PROXY_SERVER`, for example `http://host:port`
- `PLAYWRIGHT_PROXY_USERNAME`, optional
- `PLAYWRIGHT_PROXY_PASSWORD`, optional

As of 2026-06-12, both local direct access and a GitHub-hosted runner returned a `403` Cloudflare challenge without a proxy. The workflow uploads the challenged HTML and screenshot as debug artifacts instead of committing empty data.

## Local Debug

```bash
npm install
npx playwright install chromium
npm run scrape
```

Outputs are written to:

- `data/latest.json`
- `data/latest.md`
- `archive/latest/`, with one folder per captured video/headline page
- `artifacts/` when a page is challenged, empty, or otherwise suspicious

## GitHub Actions

The workflow is `.github/workflows/scrape-arabnews.yml`.

It runs every 30 minutes and can also be started manually from the Actions tab. Successful runs commit updated `data/latest.json` and `data/latest.md` back to the repository.

Successful runs also commit page snapshots under `archive/latest/`. Each item folder contains:

- `metadata.json`
- `content.md`
- `page-text.txt`
- downloaded `image.*` when a main image is available

Raw video binaries are not committed by default. Video/embed URLs discovered on article pages are recorded in metadata and Markdown; use Git LFS before committing large media files.

## Notes

Homepage cards do not always expose item-level publication timestamps. When no parseable timestamps are present, the scraper records the current homepage `Top Headlines` block at fetch time and notes that behavior in `data/latest.json`.
