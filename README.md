# kc-sand

Small GitHub Actions scraper for Arab News:

- `https://www.arabnews.com/videos`: latest 3 video items
- `https://www.arabnews.com/`: current homepage `Top Headlines`

The scraper uses Playwright instead of `curl`/`fetch` because Arab News can return a Cloudflare challenge to simple HTTP clients. The scheduled workflow runs on the `kc-sand-arabnews-vps` self-hosted runner with labels `kc-sand` and `arabnews-fixed-ip`; this reuses the same fixed-IP VPS approach used for WeChat draft uploads in `rpt_edit`, but with a separate runner registration and work directory.

If you move the workflow back to GitHub-hosted runners and they are challenged, set these repository secrets and rerun the workflow:

- `PLAYWRIGHT_PROXY_SERVER`, for example `http://host:port`
- `PLAYWRIGHT_PROXY_USERNAME`, optional
- `PLAYWRIGHT_PROXY_PASSWORD`, optional

As of 2026-06-12, a GitHub-hosted runner returned a `403` Cloudflare challenge without a proxy, while the fixed-IP VPS returned the real Arab News HTML. The workflow uploads challenged HTML and screenshots as debug artifacts instead of committing empty data.

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
- `rendered-clips/YYYY-MM-DD/`, with downloaded video `.mp4` files in the same style as `bbg-show`
- `artifacts/` when a page is challenged, empty, or otherwise suspicious

## GitHub Actions

The workflow is `.github/workflows/scrape-arabnews.yml`.

It runs every 30 minutes and can also be started manually from the Actions tab. Successful runs commit updated `data/latest.json` and `data/latest.md` back to the repository.

The runner is expected to have FFmpeg and Chromium system libraries installed by the VPS owner/root user. The workflow itself installs Node dependencies and the Playwright Chromium browser, but it does not call `sudo apt-get` because the self-hosted runner user is intentionally not passwordless sudo.

Successful runs also commit page snapshots under `archive/latest/`. Each item folder contains:

- `metadata.json`
- `content.md`
- `page-text.txt`
- downloaded `image.*` when a main image is available
- links to downloaded `.mp4` files under `rendered-clips/YYYY-MM-DD/`

Video files are capped by `MAX_VIDEO_BYTES`, defaulting to 95 MB, to stay below GitHub's 100 MB per-file limit. Use Git LFS or release assets before increasing that cap.

The workflow does not reuse previously committed video URLs as a success path. If Arab News challenges GitHub-hosted runners, configure an Action-side proxy with `PLAYWRIGHT_PROXY_SERVER` and rerun the workflow; otherwise the run fails and uploads debug artifacts instead of committing stale data.

## Notes

Homepage cards do not always expose item-level publication timestamps. When no parseable timestamps are present, the scraper records the current homepage `Top Headlines` block at fetch time and notes that behavior in `data/latest.json`.
