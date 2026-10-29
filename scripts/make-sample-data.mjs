#!/usr/bin/env node
// Writes made-up data to data/*.json so the dashboard can be previewed before
// real credentials exist. Every file is marked "sample": true; the first real
// run of fetch-data.mjs replaces them.
//
//   node scripts/make-sample-data.mjs

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DAY = 864e5;
const now = Date.now();

// Small seeded PRNG so the sample looks the same on every run.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const between = (a, b) => a + rand() * (b - a);

const roundSubs = (n) => {
  const digits = Math.floor(Math.log10(n)) + 1;
  const unit = 10 ** Math.max(0, digits - 3);
  return Math.floor(n / unit) * unit; // YouTube shows 3 significant figures
};

// ---- history: daily points for 90 days, then every 15 min for the last 7 ----
const points = [];
let subs = 48200;
let views = 9_850_000;
for (let t = now - 90 * DAY; t <= now; ) {
  const recent = t >= now - 7 * DAY;
  const step = recent ? 15 * 60e3 : DAY;
  const frac = step / DAY;
  subs += between(25, 65) * frac;
  views += between(9000, 21000) * frac;
  points.push({ t: Math.round(t), subscribers: roundSubs(subs), views: Math.round(views), videos: 412 });
  t += step;
}
const last = points[points.length - 1];

// ---- videos ----
const titles = [
  "Race Day Highlights | Full Marathon 2026",
  "Elite Men's Finish: Final 2 km",
  "Elite Women's Race Recap",
  "How to Pace Your First Half Marathon",
  "Dream Run: Runners Share Their Stories",
  "Start Line Atmosphere at 5:30 AM",
  "10K Course Preview",
  "Hydration Tips for Hot-Weather Races",
  "Post-Race Recovery: What the Pros Do",
  "Wheelchair Race Highlights",
  "Senior Citizens' Run 2026",
  "Training Week 1: Building Your Base",
  "Training Week 4: Tempo Runs Explained",
  "Expo Walkthrough & Bib Collection Guide",
  "Meet the Pacers",
  "Running for a Cause: Charity Champions",
  "Behind the Scenes: Race Operations",
  "Medal Reveal 2026",
  "Stretching Routine for Runners (10 min)",
  "Course Records Through the Years",
  "Your Questions Answered: Race Day Logistics",
  "Half Marathon Highlights",
  "Corporate Championship Recap",
  "Fueling Strategy: What to Eat Before a Race",
  "Cheering Zones Along the Route",
  "Photo Finish Moments",
  "Spirit of Mumbai: Runners' Montage",
  "Interview: Defending Champion",
  "Warm-Up Drills Every Runner Should Do",
  "Registration Now Open: Everything You Need to Know",
];
const videos = titles.map((title, i) => {
  const publishedAt = new Date(now - (i * between(4, 9) + 1) * DAY).toISOString();
  const v = Math.round(between(8000, 420000) / (1 + i * 0.08));
  return {
    id: `sample${String(i + 1).padStart(3, "0")}`,
    title,
    publishedAt,
    thumbnail: null,
    views: v,
    likes: Math.round(v * between(0.015, 0.04)),
    comments: Math.round(v * between(0.0008, 0.003)),
  };
});

// ---- analytics: last 28 days ----
const daily = [];
for (let i = 27; i >= 0; i--) {
  const d = new Date(now - (i + 2) * DAY); // analytics lag ~2 days
  const weekend = [0, 6].includes(d.getUTCDay());
  const v = Math.round(between(10000, 17000) * (weekend ? 1.35 : 1));
  daily.push({
    date: d.toISOString().slice(0, 10),
    views: v,
    watchMinutes: Math.round(v * between(2.6, 3.4)),
    subscribersGained: Math.round(between(45, 90)),
    subscribersLost: Math.round(between(6, 18)),
  });
}
const sum = (k) => daily.reduce((s, d) => s + d[k], 0);
const totalViews = sum("views");

const analytics = {
  generatedAt: new Date(now).toISOString(),
  sample: true,
  startDate: daily[0].date,
  endDate: daily[daily.length - 1].date,
  totals: {
    views: totalViews,
    watchMinutes: sum("watchMinutes"),
    avgViewDurationSec: Math.round((sum("watchMinutes") * 60) / totalViews),
    subscribersGained: sum("subscribersGained"),
    subscribersLost: sum("subscribersLost"),
  },
  daily,
  countries: [
    ["IN", 0.78], ["US", 0.05], ["AE", 0.03], ["GB", 0.025], ["KE", 0.02], ["ET", 0.015], ["SG", 0.01], ["CA", 0.01],
  ].map(([country, share]) => ({ country, views: Math.round(totalViews * share) })),
  ageGroups: [
    ["age13-17", 2.1], ["age18-24", 14.6], ["age25-34", 33.8], ["age35-44", 27.4],
    ["age45-54", 13.9], ["age55-64", 6.2], ["age65-", 2.0],
  ].map(([group, percent]) => ({ group, percent })),
  gender: [{ gender: "male", percent: 71.4 }, { gender: "female", percent: 28.3 }, { gender: "user_specified", percent: 0.3 }],
  errors: [],
};

const latest = {
  generatedAt: new Date(now).toISOString(),
  sample: true,
  channel: {
    id: "UC_SAMPLE_CHANNEL_ID",
    title: "Procam International (sample)",
    handle: "@sample",
    thumbnail: null,
    subscribers: last.subscribers,
    hiddenSubscriberCount: false,
    views: last.views,
    videos: last.videos,
  },
  topVideos: [...videos].sort((a, b) => b.views - a.views).slice(0, 25),
  recentVideos: [...videos].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 12),
};

await mkdir(DATA_DIR, { recursive: true });
const write = (name, value) => writeFile(path.join(DATA_DIR, name), JSON.stringify(value, null, 1) + "\n");
await write("latest.json", latest);
await write("history.json", { sample: true, updatedAt: latest.generatedAt, points });
await write("analytics.json", analytics);
console.log(`Wrote sample data: ${points.length} history points, ${videos.length} videos, ${daily.length} analytics days.`);
