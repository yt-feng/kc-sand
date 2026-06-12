# kc-sand Architecture

This repo is a GitHub Actions scraper for Arab News. It captures:

- the latest 3 items from `https://www.arabnews.com/videos`
- the current homepage `Top Headlines` block from `https://www.arabnews.com/`
- article snapshots, lead images, and downloaded video `.mp4` files

## Runtime

The production workflow is `.github/workflows/scrape-arabnews.yml`.

It runs every 30 minutes and can also be started manually. The job uses the self-hosted runner:

- runner name: `kc-sand-arabnews-vps`
- labels: `self-hosted`, `linux`, `x64`, `kc-sand`, `arabnews-fixed-ip`

This runner is registered separately from the `rpt_edit` WeChat runner, but it uses the same fixed-IP VPS approach. The runner user is intentionally not passwordless sudo. System packages such as FFmpeg and Chromium runtime libraries are installed on the VPS by root; the workflow only installs Node dependencies and the Playwright Chromium browser.

## Scrape Flow

1. GitHub Actions checks out the repo on the fixed-IP VPS runner.
2. The workflow installs Node 22 dependencies with `npm ci`.
3. It installs Playwright Chromium with `npx playwright install chromium`.
4. `npm run scrape` runs `scripts/scrape-arabnews.mjs`.
5. The script first tries Playwright navigation for the videos page and homepage.
6. If Playwright receives a Cloudflare challenge, a 4xx response, or an empty page, the script uses `curl --compressed` on the same Action runner to fetch live HTML.
7. The live HTML is parsed with the same DOM extractor. This is a live fallback, not a cache fallback.
8. The script archives article pages, images, and video metadata under `archive/latest/`.
9. For video items, the script resolves JWPlayer media URLs and downloads `.mp4` files under `rendered-clips/YYYY-MM-DD/`.
10. The workflow commits `data/latest.json`, `data/latest.md`, `archive/latest/`, and `rendered-clips/` back to the repo.

## Cloudflare Handling

As of 2026-06-12:

- GitHub-hosted runners received a Cloudflare `403` challenge from Arab News.
- The fixed-IP VPS could fetch real Arab News HTML with `curl`.
- Headless Playwright on the same VPS could still be challenged.

Because of that, the current architecture uses Playwright as the first path and `curl` live HTML fallback as the recovery path. The fallback only reads Arab News during that Action run. It does not use previously committed URLs or old repo data as a success path.

Debug files are uploaded as the `arabnews-debug` artifact. With `save_artifacts=true`, successful runs also upload listing HTML and screenshots. Challenge artifacts are named like:

- `artifacts/arabnews-videos.json`
- `artifacts/arabnews-videos.html`
- `artifacts/arabnews-videos-curl.json`
- `artifacts/arabnews-videos-curl.html`

## Video Downloading

Video pages often expose JWPlayer URLs. The downloader:

1. captures candidate URLs from the page or live HTML
2. expands JWPlayer media IDs through `https://content.jwplatform.com/v2/media/<id>`
3. prefers direct MP4 sources
4. falls back to HLS download through FFmpeg when needed

Downloaded video files are capped by `MAX_VIDEO_BYTES`, currently `95,000,000`, so each committed file stays below GitHub's 100 MB file limit.

## Output Layout

Current output files:

```text
data/latest.json
data/latest.md
archive/latest/index.json
archive/latest/index.md
archive/latest/videos/<item>/
archive/latest/headlines/<item>/
rendered-clips/YYYY-MM-DD/*.mp4
```

Each archived item directory contains:

- `metadata.json`
- `content.md`
- `page-text.txt`
- `image.*` when available

Video item metadata also records the downloaded video path, source URL, bytes, and method.

## VPS Cleanup

The VPS is treated as disposable Action workspace storage. It does not need to retain generated scrape data after the workflow has committed outputs to GitHub.

A systemd timer cleans runner workspaces and caches every 72 hours:

- service: `actions-runner-cleanup.service`
- timer: `actions-runner-cleanup.timer`
- script: `/usr/local/sbin/actions-runner-cleanup.sh`

The cleanup script removes:

- `/opt/actions-runner-*/_work/*`
- old runner diagnostic files
- `/home/github-runner/.cache/ms-playwright`
- `/home/github-runner/.cache/pip`
- `/home/github-runner/.npm`

It does not remove runner registrations, credentials, service files, or runner binaries. If a GitHub Actions job is actively running, cleanup skips that cycle.

## Failure Policy

The workflow should fail instead of committing stale or empty data when live capture does not produce the required items.

Failure conditions include:

- fewer than 3 video items
- no homepage Top Headlines
- challenged article pages after fallback
- missing downloaded video files for video items
- archive errors

This keeps the repository state honest: a green run means the Action captured current live data and downloaded the expected video files.
