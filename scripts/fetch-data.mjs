#!/usr/bin/env node
// Pulls channel stats from the YouTube Data API and, when OAuth credentials are
// set, watch time / audience data from the YouTube Analytics API.
// Writes data/latest.json, data/history.json and data/analytics.json for the
// dashboard. Run on a schedule by .github/workflows/update-data.yml.
//
// Environment:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN  OAuth (full data)
//   YT_API_KEY                                                    API key (public stats only)
//   YT_CHANNEL_ID                                                 required with an API key, optional with OAuth
//   FORCE_ANALYTICS=true                                          refresh analytics even if recent
//   MAX_VIDEOS                                                    uploads to scan (default 1500)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");

const env = process.env;
const API_KEY = env.YT_API_KEY?.trim();
const CHANNEL_ID = env.YT_CHANNEL_ID?.trim();
const CLIENT_ID = env.GOOGLE_CLIENT_ID?.trim();
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET?.trim();
const REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN?.trim();
const FORCE_ANALYTICS = env.FORCE_ANALYTICS === "true";
const FORCE_BACKFILL = env.BACKFILL === "true";
const MAX_VIDEOS = Number(env.MAX_VIDEOS) || 1500;

const DAY = 864e5;
const TOP_N = 25;
const RECENT_N = 12;
const ANALYTICS_MAX_AGE_MS = 6 * 3600e3;
const ANALYTICS_DAYS = 28;
const FULL_HISTORY_MS = 7 * DAY; // keep every point this recent; older history keeps one point per day
const BACKFILL_DAYS = 3 * 365;

async function main() {
  const hasOAuth = Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
  if (!hasOAuth && !(API_KEY && CHANNEL_ID)) {
    console.log("::notice::No YouTube credentials configured yet; skipping. Add the GitHub secrets described in README.md.");
    return;
  }

  const token = hasOAuth ? await getAccessToken() : null;
  const now = Date.now();

  const channel = await fetchChannel(token);
  console.log(`Channel: ${channel.title} (${channel.id}), ${channel.subscribers ?? "hidden"} subscribers, ${channel.views} views`);

  const videos = await fetchVideos(channel.uploadsPlaylistId, token);
  console.log(`Fetched stats for ${videos.length} public videos`);

  const { uploadsPlaylistId, ...channelOut } = channel;
  await writeJson("latest.json", {
    generatedAt: new Date(now).toISOString(),
    sample: false,
    channel: channelOut,
    topVideos: [...videos].sort((a, b) => b.views - a.views).slice(0, TOP_N),
    recentVideos: [...videos].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, RECENT_N),
  });

  await appendHistory({ t: now, subscribers: channel.subscribers, views: channel.views, videos: channel.videos });

  if (token) {
    await maybeBackfillHistory(token, channel, now);
    await maybeUpdateAnalytics(token, now);
  } else {
    console.log("No OAuth credentials; skipping YouTube Analytics (watch time, audience).");
  }
}

// ---------- auth & HTTP ----------

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const hint = body.error === "invalid_grant"
      ? " The refresh token has expired or been revoked; run scripts/get-refresh-token.mjs again (and make sure the OAuth consent screen is set to 'In production')."
      : "";
    throw new Error(`Could not get an access token: ${body.error_description || body.error || res.status}.${hint}`);
  }
  return body.access_token;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    throw new Error(`${res.status} from ${url.pathname}: ${body.error?.message || text.slice(0, 200)}`);
  }
  return body;
}

function dataApi(resource, params, token) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else url.searchParams.set("key", API_KEY);
  return getJson(url, headers);
}

// ---------- YouTube Data API ----------

async function fetchChannel(token) {
  const params = { part: "snippet,statistics,contentDetails" };
  if (CHANNEL_ID) params.id = CHANNEL_ID;
  else params.mine = "true";
  const body = await dataApi("channels", params, token);
  const c = body.items?.[0];
  if (!c) {
    throw new Error(CHANNEL_ID
      ? `No channel found with ID ${CHANNEL_ID}.`
      : "The signed-in Google account has no YouTube channel. Re-run get-refresh-token.mjs and pick the Procam channel.");
  }
  const s = c.statistics;
  return {
    id: c.id,
    title: c.snippet.title,
    handle: c.snippet.customUrl || null,
    thumbnail: c.snippet.thumbnails?.medium?.url || c.snippet.thumbnails?.default?.url || null,
    subscribers: s.hiddenSubscriberCount ? null : Number(s.subscriberCount),
    hiddenSubscriberCount: Boolean(s.hiddenSubscriberCount),
    views: Number(s.viewCount),
    videos: Number(s.videoCount),
    uploadsPlaylistId: c.contentDetails.relatedPlaylists.uploads,
  };
}

async function fetchVideos(uploadsPlaylistId, token) {
  const ids = new Set(); // the API sometimes repeats items across pages
  let pageToken;
  do {
    const page = await dataApi("playlistItems", {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    }, token);
    for (const item of page.items || []) ids.add(item.contentDetails.videoId);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.size < MAX_VIDEOS);

  const videos = [];
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 50) {
    const batch = await dataApi("videos", {
      part: "snippet,statistics,status",
      id: idList.slice(i, i + 50).join(","),
    }, token);
    for (const v of batch.items || []) {
      if (v.status?.privacyStatus !== "public") continue;
      const s = v.statistics || {};
      videos.push({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || null,
        views: Number(s.viewCount || 0),
        likes: s.likeCount != null ? Number(s.likeCount) : null,
        comments: s.commentCount != null ? Number(s.commentCount) : null,
      });
    }
  }
  return videos;
}

// ---------- history ----------

async function appendHistory(point) {
  let hist = await readJson("history.json", { points: [] });
  if (hist.sample) hist = { points: [] }; // first real run replaces the sample data
  const points = (hist.points || []).filter((p) => p.t < point.t);
  points.push(point);
  await writeJson("history.json", {
    sample: false,
    updatedAt: new Date(point.t).toISOString(),
    points: prune(points, point.t),
  });
}

function prune(points, now) {
  const recent = [];
  const daily = new Map();
  for (const p of points) {
    if (p.t >= now - FULL_HISTORY_MS) recent.push(p);
    else daily.set(new Date(p.t).toISOString().slice(0, 10), p); // last point of each UTC day wins
  }
  return [...daily.values(), ...recent].sort((a, b) => a.t - b.t);
}

// ---------- YouTube Analytics API ----------

async function analyticsRows(token, params) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.search = new URLSearchParams({ ids: "channel==MINE", ...params }).toString();
  const body = await getJson(url, { Authorization: `Bearer ${token}` });
  const cols = (body.columnHeaders || []).map((h) => h.name);
  return (body.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

// The Data API only reports current totals, so growth history would otherwise
// start on the day tracking began. Rebuild one point per day from Analytics by
// walking back from the first tracked snapshot and subtracting each day's net
// change. Runs once (when no backfilled points exist yet), or when BACKFILL=true.
async function maybeBackfillHistory(token, channel, now) {
  const hist = await readJson("history.json", { points: [] });
  const tracked = (hist.points || []).filter((p) => !p.backfilled);
  const anchor = tracked[0] || { t: now, subscribers: channel.subscribers, views: channel.views };
  const firstTracked = anchor.t;
  if (!FORCE_BACKFILL && (hist.points || []).some((p) => p.backfilled)) return;

  let rows;
  try {
    rows = await analyticsRows(token, {
      startDate: isoDate(now - BACKFILL_DAYS * DAY),
      endDate: isoDate(now),
      metrics: "views,subscribersGained,subscribersLost",
      dimensions: "day",
      sort: "-day",
    });
  } catch (err) {
    console.warn(`::warning::History backfill failed: ${err.message}`);
    return;
  }

  // Analytics lags 1-3 days, so the newest backfilled day lands on the anchor
  // value; days after the anchor are already covered by tracked snapshots.
  let subs = anchor.subscribers;
  let views = anchor.views;
  const backfilled = [];
  for (const r of rows) {
    const t = Date.parse(`${r.day}T23:59:59Z`);
    if (t >= firstTracked) continue; // already counted in the anchor snapshot
    if (views < 0) break;
    backfilled.push({ t, subscribers: subs != null ? Math.max(0, subs) : null, views, videos: null, backfilled: true });
    if (subs != null) subs -= r.subscribersGained - r.subscribersLost;
    views -= r.views;
  }

  await writeJson("history.json", {
    sample: false,
    updatedAt: hist.updatedAt || new Date(now).toISOString(),
    points: prune([...backfilled, ...tracked], now),
  });
  console.log(`Backfilled ${backfilled.length} daily history points from YouTube Analytics`);
}

async function maybeUpdateAnalytics(token, now) {
  const existing = await readJson("analytics.json", null);
  const age = existing && !existing.sample ? now - Date.parse(existing.generatedAt) : Infinity;
  if (!FORCE_ANALYTICS && age < ANALYTICS_MAX_AGE_MS) {
    console.log(`Analytics refreshed ${Math.round(age / 60e3)} min ago; skipping until it is 6 h old.`);
    return;
  }

  const endDate = isoDate(now);
  const startDate = isoDate(now - (ANALYTICS_DAYS - 1) * DAY);
  const errors = [];

  const report = async (name, params) => {
    try {
      return await analyticsRows(token, { startDate, endDate, ...params });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      console.warn(`::warning::Analytics report "${name}" failed: ${err.message}`);
      return null;
    }
  };

  const metrics = "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost";
  const [totals, daily, countries, ages, genders] = await Promise.all([
    report("totals", { metrics }),
    report("daily", { metrics, dimensions: "day", sort: "day" }),
    report("countries", { metrics: "views", dimensions: "country", sort: "-views", maxResults: "10" }),
    report("age", { metrics: "viewerPercentage", dimensions: "ageGroup", sort: "ageGroup" }),
    report("gender", { metrics: "viewerPercentage", dimensions: "gender", sort: "-viewerPercentage" }),
  ]);

  if ([totals, daily, countries, ages, genders].every((r) => r === null)) {
    throw new Error(`Every YouTube Analytics report failed; keeping the previous analytics.json.\n${errors.join("\n")}`);
  }

  const t = totals?.[0] || {};
  await writeJson("analytics.json", {
    generatedAt: new Date(now).toISOString(),
    sample: false,
    startDate,
    endDate,
    totals: {
      views: t.views ?? null,
      watchMinutes: t.estimatedMinutesWatched ?? null,
      avgViewDurationSec: t.averageViewDuration ?? null,
      subscribersGained: t.subscribersGained ?? null,
      subscribersLost: t.subscribersLost ?? null,
    },
    daily: (daily || []).map((d) => ({
      date: d.day,
      views: d.views,
      watchMinutes: d.estimatedMinutesWatched,
      subscribersGained: d.subscribersGained,
      subscribersLost: d.subscribersLost,
    })),
    countries: (countries || []).map((r) => ({ country: r.country, views: r.views })),
    ageGroups: (ages || []).map((r) => ({ group: r.ageGroup, percent: r.viewerPercentage })),
    gender: (genders || []).map((r) => ({ gender: r.gender, percent: r.viewerPercentage })),
    errors,
  });
  console.log(`Analytics updated for ${startDate} → ${endDate}${errors.length ? ` (${errors.length} report(s) failed)` : ""}`);
}

// ---------- files ----------

function isoDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(name, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, name), JSON.stringify(value, null, 1) + "\n");
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exitCode = 1;
});
