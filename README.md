# Procam YouTube Dashboard

A dashboard for the Procam International YouTube channel: subscribers, views, growth over time, top videos, watch time, traffic sources and audience. It runs entirely on GitHub: no server, no database, no cost.

```
GitHub Actions (every ~15 min)
  └─ scripts/fetch-data.mjs ── YouTube Data API ───────── subscribers, views, videos
                            └─ YouTube Analytics API ──── watch time, traffic, audience (every 6 h)
  └─ commits data/*.json to this repo
GitHub Pages
  └─ index.html reads data/*.json and draws the dashboard
  └─ "Refresh live" button ── YouTube Data API (from the browser) ── latest counts on demand
```

Until credentials are added, the site shows **sample data** (marked with a banner).

## What updates when

| Data | Source | Freshness |
|---|---|---|
| Subscribers, total views, video count, per-video views/likes/comments | YouTube Data API | Every ~15 min automatically; instantly with **Refresh live** |
| Subscriber & view growth charts | Snapshots saved by the scheduled job | Every ~15 min |
| Watch time, subscribers gained/lost, traffic sources, countries, age/gender | YouTube Analytics API | Every 6 h, but YouTube itself reports this 1–3 days late |

YouTube rounds public subscriber counts to three significant figures (e.g. 52,300), including through the API. The exact daily gains and losses come from the Analytics section.

## Setup

### 1. Google Cloud project (on procamrunning@gmail.com)

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "Procam YouTube Dashboard").
2. **APIs & Services → Library**: enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**. Fill in the app name and support email.
   - Scopes: `youtube.readonly` and `yt-analytics.readonly`.
   - **Publish the app (status "In production")**. In "Testing" status, Google expires the refresh token after 7 days and the dashboard stops updating. The app doesn't need Google verification for this use; the owner just clicks through an "unverified app" warning once.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**: type **Desktop app**. Note the **Client ID** and **Client secret**.
5. **Credentials → Create credentials → API key** (for the Refresh live button). Then **edit the key**:
   - Application restrictions → **Websites** → add `https://procamyoutubeexpert.github.io/*`
   - API restrictions → **Restrict key** → only **YouTube Data API v3**

   This key is visible in the page source; the restrictions are what keep it safe.

Using the API is free. The default quota is 10,000 units/day; this dashboard uses roughly 1,000–1,500 a day plus ~3 per Refresh live click.

### 2. Get the refresh token (once, by the channel owner)

On a computer with Node.js 20+:

```bash
GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" \
GOOGLE_CLIENT_SECRET="yyy" \
node scripts/get-refresh-token.mjs
```

A browser opens: sign in with the account that manages the channel and, if asked, **choose the Procam channel** (not a personal channel). The terminal prints the channel name, so check it is right, followed by the refresh token.

### 3. GitHub repository settings

**Settings → Secrets and variables → Actions**

| Kind | Name | Value |
|---|---|---|
| Secret | `GOOGLE_CLIENT_ID` | OAuth client ID |
| Secret | `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| Secret | `GOOGLE_REFRESH_TOKEN` | from step 2 |
| Secret | `YT_API_KEY` | optional: only needed if you skip OAuth (public stats only) |
| Variable | `YT_CHANNEL_ID` | optional with OAuth; required with only an API key |

**Settings → Pages** → Source: **Deploy from a branch** → `main` / `/ (root)`.

Then **Actions → Update YouTube data → Run workflow** (tick "Refresh YouTube Analytics now") to replace the sample data straight away.

### 4. Turn on the Refresh live button

Edit `config.js`: set `apiKey` to the restricted API key from step 1.5 (and optionally `channelId`). Commit and push.

## Local preview

```bash
python3 -m http.server 8000      # then open http://localhost:8000
node scripts/make-sample-data.mjs  # regenerate the sample data
```

The Refresh live button won't work on localhost if the API key is restricted to the GitHub Pages address. Add `http://localhost:8000/*` to the key's allowed websites while testing.

## Files

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The dashboard page (plain HTML/CSS/JS, Chart.js from a CDN) |
| `config.js` | Public settings: browser API key, channel ID, number format |
| `data/` | JSON written by the scheduled job (`latest`, `history`, `analytics`) |
| `scripts/fetch-data.mjs` | Fetches from the YouTube APIs and writes `data/` |
| `scripts/get-refresh-token.mjs` | One-time OAuth sign-in helper |
| `scripts/make-sample-data.mjs` | Generates the sample data |
| `.github/workflows/update-data.yml` | Runs the fetch every 15 minutes and commits the data |

## Notes

- **The site is public.** GitHub Pages sites are public on free and Team plans. Anyone with the link can see everything on the dashboard, including the analytics section.
- **Scheduled runs are best-effort.** GitHub sometimes delays cron runs by several minutes at busy times.
- **Token problems.** If the Action fails with `invalid_grant`, the refresh token was revoked or expired. Re-run step 2 and update the `GOOGLE_REFRESH_TOKEN` secret.
