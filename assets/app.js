(() => {
  "use strict";

  const CONFIG = Object.assign(
    { apiKey: "", channelId: "", locale: "en-IN", refreshCooldownSeconds: 30, autoReloadMinutes: 5 },
    window.DASHBOARD_CONFIG || {}
  );

  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const RANGES = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY, all: Infinity };

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat(CONFIG.locale);
  const pf = new Intl.NumberFormat(CONFIG.locale, { maximumFractionDigits: 1 });
  const dayFmt = new Intl.DateTimeFormat(CONFIG.locale, { day: "numeric", month: "short" });
  const dateFmt = new Intl.DateTimeFormat(CONFIG.locale, { day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat(CONFIG.locale, { hour: "2-digit", minute: "2-digit" });
  const dateTimeFmt = new Intl.DateTimeFormat(CONFIG.locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* older browsers */ }

  const state = {
    latest: null,
    history: [],
    analytics: null,
    range: "30d",
    live: null, // { at, channel: {...}, videos: { id: {views, likes, comments} } }
    charts: {},
    cooldownUntil: 0,
  };

  // ---------- formatting ----------

  const isNum = (n) => typeof n === "number" && Number.isFinite(n);
  const fmt = (n) => (isNum(n) ? nf.format(Math.round(n)) : "—");
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function fmtDuration(sec) {
    if (!isNum(sec)) return "—";
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  }

  function fmtAgo(t) {
    const diff = Date.now() - t;
    if (diff < 60e3) return "just now";
    if (diff < HOUR) return `${Math.round(diff / 60e3)} min ago`;
    if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`;
    const days = Math.round(diff / DAY);
    return days < 30 ? `${days} day${days === 1 ? "" : "s"} ago` : dateFmt.format(t);
  }

  function signed(n) {
    if (!isNum(n)) return "—";
    return (n > 0 ? "+" : n < 0 ? "−" : "") + nf.format(Math.abs(Math.round(n)));
  }

  function setDelta(el, delta, suffix) {
    el.replaceChildren();
    if (!isNum(delta)) return;
    const span = document.createElement("span");
    span.className = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
    span.textContent = `${delta > 0 ? "▲ " : delta < 0 ? "▼ " : ""}${signed(delta)}`;
    el.append(span, document.createTextNode(` ${suffix}`));
  }

  // ---------- data loading ----------

  async function loadJson(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function loadData() {
    try {
      const [latest, history, analytics] = await Promise.all([
        loadJson("data/latest.json"),
        loadJson("data/history.json").catch(() => ({ points: [] })),
        loadJson("data/analytics.json").catch(() => null),
      ]);
      state.latest = latest;
      state.history = (history.points || []).slice().sort((a, b) => a.t - b.t);
      state.analytics = analytics;
      render();
    } catch (err) {
      showNotice("error", `Couldn't load dashboard data: ${err.message}`);
    }
  }

  // Live values only win while they are newer than the scheduled snapshot.
  function liveIsCurrent() {
    return !!(state.live && state.latest && state.live.at > Date.parse(state.latest.generatedAt));
  }

  function currentChannel() {
    const base = state.latest?.channel || {};
    return liveIsCurrent() ? { ...base, ...state.live.channel } : base;
  }

  function currentVideo(v) {
    const live = liveIsCurrent() && state.live.videos[v.id];
    return live ? { ...v, ...live } : v;
  }

  // ---------- live refresh (YouTube Data API, from the browser) ----------

  async function yt(resource, params) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", CONFIG.apiKey);
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
    return body;
  }

  async function refreshLive() {
    if (Date.now() < state.cooldownUntil) return;
    if (!CONFIG.apiKey) {
      showNotice("warn", "Live refresh isn't switched on yet: the browser API key still needs to be added to config.js.");
      return;
    }
    const channelId = CONFIG.channelId || state.latest?.channel?.id;
    if (!channelId || state.latest?.sample && !CONFIG.channelId) {
      showNotice("warn", "Live refresh needs the channel ID: add it to config.js, or wait for the first scheduled update.");
      return;
    }

    const btn = $("refresh-btn");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    document.body.classList.add("loading");
    try {
      const ch = await yt("channels", { part: "statistics", id: channelId });
      const item = ch.items?.[0];
      if (!item) throw new Error("channel not found. Check the channel ID in config.js.");
      const s = item.statistics;

      const ids = [...new Set([...(state.latest?.topVideos || []), ...(state.latest?.recentVideos || [])].map((v) => v.id))].slice(0, 50);
      const videos = {};
      if (ids.length) {
        const vr = await yt("videos", { part: "statistics", id: ids.join(",") });
        for (const v of vr.items || []) {
          videos[v.id] = {
            views: Number(v.statistics.viewCount),
            likes: v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
            comments: v.statistics.commentCount != null ? Number(v.statistics.commentCount) : null,
          };
        }
      }

      state.live = {
        at: Date.now(),
        channel: {
          subscribers: s.hiddenSubscriberCount ? null : Number(s.subscriberCount),
          hiddenSubscriberCount: !!s.hiddenSubscriberCount,
          views: Number(s.viewCount),
          videos: Number(s.videoCount),
        },
        videos,
      };
      hideNotice();
      render();
    } catch (err) {
      showNotice("error", `Live refresh failed: ${err.message}`);
    } finally {
      document.body.classList.remove("loading");
      startCooldown();
    }
  }

  function startCooldown() {
    const btn = $("refresh-btn");
    state.cooldownUntil = Date.now() + CONFIG.refreshCooldownSeconds * 1000;
    const tick = () => {
      const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
      if (left <= 0) {
        btn.disabled = false;
        btn.textContent = "Refresh live";
        return;
      }
      btn.disabled = true;
      btn.textContent = `Refresh live (${left}s)`;
      setTimeout(tick, 1000);
    };
    tick();
  }

  // ---------- notices ----------

  function showNotice(kind, text) {
    const el = $("notice");
    el.className = `notice notice-${kind}`;
    el.textContent = text;
    el.hidden = false;
  }

  function hideNotice() {
    $("notice").hidden = true;
  }

  // ---------- rendering ----------

  function render() {
    if (!state.latest) return;
    renderHeader();
    renderTiles();
    renderGrowth();
    renderAnalytics();
    renderVideos();
  }

  function renderHeader() {
    const { latest } = state;
    const ch = latest.channel || {};
    $("channel-title").textContent = ch.title || "YouTube Dashboard";
    document.title = ch.title ? `${ch.title} · YouTube Dashboard` : "YouTube Dashboard";
    $("channel-meta").textContent = ch.handle ? `${ch.handle} · YouTube channel dashboard` : "YouTube channel dashboard";
    const avatar = $("channel-avatar");
    if (ch.thumbnail) {
      avatar.src = ch.thumbnail;
      avatar.hidden = false;
    } else {
      avatar.hidden = true;
    }
    $("sample-banner").hidden = !latest.sample;
    $("updated").textContent = liveIsCurrent()
      ? `Live · fetched at ${timeFmt.format(state.live.at)}`
      : `Updated ${fmtAgo(Date.parse(latest.generatedAt))}`;
    document.querySelectorAll("[data-live-pill]").forEach((el) => { el.hidden = !liveIsCurrent(); });
  }

  // History value at or before time t (falls back to the earliest point).
  function historyAt(t) {
    const pts = state.history;
    if (!pts.length) return null;
    let found = null;
    for (const p of pts) {
      if (p.t <= t) found = p;
      else break;
    }
    return found;
  }

  function referenceTime() {
    return liveIsCurrent() ? state.live.at : Date.parse(state.latest.generatedAt);
  }

  function renderTiles() {
    const ch = currentChannel();
    const base = historyAt(referenceTime() - DAY);

    $("t-subs").textContent = ch.hiddenSubscriberCount ? "Hidden" : fmt(ch.subscribers);
    setDelta($("t-subs-delta"), base && isNum(ch.subscribers) ? ch.subscribers - base.subscribers : null, "in 24h");

    $("t-views").textContent = fmt(ch.views);
    setDelta($("t-views-delta"), base && isNum(ch.views) ? ch.views - base.views : null, "in 24h");

    $("t-videos").textContent = fmt(ch.videos);
    const newest = state.latest.recentVideos?.[0];
    $("t-videos-foot").textContent = newest ? `Last upload ${fmtAgo(Date.parse(newest.publishedAt))}` : "";
  }

  function renderGrowth() {
    document.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === state.range)));

    const pts = state.history.slice();
    const ch = currentChannel();
    if (liveIsCurrent() && isNum(ch.views)) {
      pts.push({ t: state.live.at, subscribers: ch.subscribers, views: ch.views, videos: ch.videos, live: true });
    }
    const end = pts.length ? pts[pts.length - 1].t : Date.now();

    // With under 30 minutes of history there is nothing to draw: hide the
    // section and leave a short note in the footer instead of empty boxes.
    const tooShort = pts.length < 2 || end - pts[0].t < 30 * 60e3;
    $("growth").hidden = tooShort;
    $("growth-note").hidden = !tooShort;
    if (tooShort) {
      $("growth-note").textContent = pts.length
        ? `Growth charts will appear here once a little history has been recorded (tracking started ${dateTimeFmt.format(pts[0].t)}).`
        : "Growth charts will appear here once a little history has been recorded.";
      return;
    }

    const span = RANGES[state.range];
    const shown = span === Infinity ? pts : pts.filter((p) => p.t >= end - span);
    // Start the axis at the first snapshot when history is shorter than the range.
    const xMin = shown.length ? Math.max(end - span, shown[0].t) : undefined;

    lineChart("subs", $("c-subs"), shown.filter((p) => isNum(p.subscribers)).map((p) => ({ x: p.t, y: p.subscribers })), "subscribers", xMin, end, "--line-subs");
    lineChart("views", $("c-views"), shown.map((p) => ({ x: p.t, y: p.views })), "views", xMin, end, "--line-views");

    const daily = dailyLast(shown);
    fillTable($("tbl-subs"), ["Date", "Subscribers"], daily.map((p) => [dateFmt.format(p.t), fmt(p.subscribers)]));
    fillTable($("tbl-views"), ["Date", "Total views"], daily.map((p) => [dateFmt.format(p.t), fmt(p.views)]));
  }

  // Last point of each day, newest first, for the table views.
  function dailyLast(points) {
    const byDay = new Map();
    for (const p of points) byDay.set(new Date(p.t).toDateString(), p);
    return [...byDay.values()].reverse();
  }

  function renderAnalytics() {
    const a = state.analytics;
    const has = !!(a && a.totals);
    $("analytics-empty").hidden = has;
    $("analytics-body").hidden = !has;
    if (!has) {
      $("analytics-meta").textContent = "";
      return;
    }

    $("analytics-meta").textContent =
      `${dateFmt.format(Date.parse(a.startDate))} – ${dateFmt.format(Date.parse(a.endDate))} · updated ${fmtAgo(Date.parse(a.generatedAt))}`;

    const t = a.totals;
    $("a-views").textContent = fmt(t.views);
    $("a-watch").textContent = isNum(t.watchMinutes) ? fmt(t.watchMinutes / 60) : "—";
    $("a-avd").textContent = fmtDuration(t.avgViewDurationSec);
    const net = isNum(t.subscribersGained) && isNum(t.subscribersLost) ? t.subscribersGained - t.subscribersLost : null;
    $("a-net").textContent = signed(net);
    $("a-net-foot").textContent = isNum(net) ? `${fmt(t.subscribersGained)} gained · ${fmt(t.subscribersLost)} lost` : "";
    const kept = isNum(net) && t.subscribersGained > 0 ? Math.max(0, net / t.subscribersGained) : null;
    gauge($("g-retention"), kept, "kept");

    dailyChart(a.daily || []);
    fillTable(
      $("tbl-daily"),
      ["Date", "Views", "Watch hours", "Subs gained", "Subs lost"],
      (a.daily || []).slice().reverse().map((d) => [
        dateFmt.format(Date.parse(d.date)), fmt(d.views), fmt(d.watchMinutes / 60), fmt(d.subscribersGained), fmt(d.subscribersLost),
      ])
    );

    const countries = a.countries || [];
    const countryTotal = isNum(t.views) && t.views > 0 ? t.views : countries.reduce((s, r) => s + r.views, 0);
    hbars($("b-countries"), countries.slice(0, 8).map((r) => ({
      label: countryName(r.country),
      value: countryTotal ? (r.views / countryTotal) * 100 : 0,
      title: `${fmt(r.views)} views`,
    })));

    hbars($("b-age"), (a.ageGroups || []).map((r) => ({
      label: r.group.replace(/^age/, "").replace("-", "–"),
      value: r.percent,
    })));

    const genderColors = { male: css("--sky"), female: css("--peach") };
    const g = (a.gender || []).map((r) => ({
      label: /user/i.test(r.gender) ? "Other" : titleCase(r.gender),
      value: r.percent,
      color: genderColors[r.gender] || css("--white"),
    }));
    donut($("d-gender"), g);
    legend($("gender-split"), g);
  }

  function renderVideos() {
    const { latest } = state;
    videoTable($("tbl-top"), (latest.topVideos || []).map(currentVideo).sort((a, b) => b.views - a.views));
    videoTable($("tbl-recent"), (latest.recentVideos || []).map(currentVideo));
  }

  // ---------- tables & bars ----------

  function fillTable(table, headers, rows) {
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.textContent = h;
      if (i > 0) th.className = "num";
      hr.append(th);
    });
    thead.append(hr);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      row.forEach((cell, i) => {
        const td = document.createElement("td");
        td.textContent = cell;
        if (i > 0) td.className = "num";
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
  }

  function videoTable(table, videos) {
    const thead = document.createElement("thead");
    thead.innerHTML = '<tr><th>Video</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th></tr>';
    const tbody = document.createElement("tbody");
    for (const v of videos) {
      const tr = document.createElement("tr");

      const tdVid = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "vid";
      if (v.thumbnail) {
        const img = document.createElement("img");
        img.src = v.thumbnail;
        img.alt = "";
        img.loading = "lazy";
        wrap.append(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "thumb-ph";
        wrap.append(ph);
      }
      const text = document.createElement("div");
      const a = document.createElement("a");
      a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = v.title;
      const date = document.createElement("div");
      date.className = "date";
      date.textContent = v.publishedAt ? dateFmt.format(Date.parse(v.publishedAt)) : "";
      text.append(a, date);
      wrap.append(text);
      tdVid.append(wrap);
      tr.append(tdVid);

      for (const n of [v.views, v.likes, v.comments]) {
        const td = document.createElement("td");
        td.className = "num";
        td.textContent = fmt(n);
        tr.append(td);
      }
      tbody.append(tr);
    }
    if (!videos.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 4;
      td.className = "muted";
      td.textContent = "No videos yet.";
      tr.append(td);
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
  }

  function hbars(el, rows) {
    el.replaceChildren();
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No data for this period.";
      el.append(p);
      return;
    }
    const max = Math.max(...rows.map((r) => r.value), 0.0001);
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "hbar";
      if (r.title) row.title = r.title;
      const label = document.createElement("span");
      label.className = "hbar-label";
      label.textContent = r.label;
      const track = document.createElement("div");
      track.className = "hbar-track";
      const fill = document.createElement("div");
      fill.className = "hbar-fill";
      fill.style.width = `${(r.value / max) * 100}%`;
      track.append(fill);
      const value = document.createElement("span");
      value.className = "hbar-value";
      value.textContent = r.value > 0 && r.value < 0.05 ? "<0.1%" : `${pf.format(r.value)}%`;
      row.append(label, track, value);
      el.append(row);
    }
  }

  // ---------- gauge & donut (inline SVG) ----------

  const CHART_FONT = '"Outfit", system-ui, -apple-system, "Segoe UI", sans-serif';
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function svgText(x, y, text, attrs) {
    const el = svgEl("text", { x, y, "text-anchor": "middle", ...attrs });
    el.textContent = text;
    return el;
  }

  // Half-circle gauge for a 0–1 share, with a needle like the reference.
  function gauge(el, fraction, caption) {
    el.replaceChildren();
    if (!isNum(fraction)) return;
    const f = Math.min(1, Math.max(0, fraction));
    const cx = 60, cy = 58, r = 46;
    const at = (a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy - r * Math.sin(a)).toFixed(2)}`;
    const end = Math.PI - f * Math.PI;
    const svg = svgEl("svg", { viewBox: "0 0 120 84" });
    svg.append(
      svgEl("path", { d: `M ${at(Math.PI)} A ${r} ${r} 0 0 1 ${at(0)}`, fill: "none", stroke: css("--track"), "stroke-width": 10 }),
      svgEl("path", { d: `M ${at(Math.PI)} A ${r} ${r} 0 0 1 ${at(end)}`, fill: "none", stroke: css("--peach"), "stroke-width": 10 }),
      svgEl("line", {
        x1: cx, y1: cy,
        x2: (cx + (r - 8) * Math.cos(end)).toFixed(2), y2: (cy - (r - 8) * Math.sin(end)).toFixed(2),
        stroke: css("--white"), "stroke-width": 3, "stroke-linecap": "round",
      }),
      svgEl("circle", { cx, cy, r: 4, fill: css("--white") }),
      svgText(cx, 80, `${Math.round(f * 100)}% ${caption}`, { "font-size": 12, opacity: 0.85 })
    );
    el.setAttribute("aria-label", `${Math.round(f * 100)}% of new subscribers ${caption}`);
    el.append(svg);
  }

  // Ring split into segments, with a 2-unit gap between them.
  function donut(el, rows) {
    el.replaceChildren();
    const total = rows.reduce((s, r) => s + r.value, 0);
    if (!total) return;
    const r = 46, c = 2 * Math.PI * r, gap = rows.length > 1 ? 2 : 0;
    const svg = svgEl("svg", { viewBox: "0 0 120 120" });
    svg.append(svgEl("circle", { cx: 60, cy: 60, r, fill: "none", stroke: css("--track"), "stroke-width": 12 }));
    let offset = 0;
    for (const row of rows) {
      const len = (row.value / total) * c;
      if (len > gap) {
        svg.append(svgEl("circle", {
          cx: 60, cy: 60, r, fill: "none", stroke: row.color, "stroke-width": 12,
          "stroke-dasharray": `${len - gap} ${c - len + gap}`,
          "stroke-dashoffset": -offset,
          transform: "rotate(-90 60 60)",
        }));
      }
      offset += len;
    }
    const top = rows.reduce((a, b) => (b.value > a.value ? b : a));
    svg.append(
      svgText(60, 62, `${Math.round(top.value)}%`, { "font-size": 24, "font-weight": 500 }),
      svgText(60, 80, top.label.toLowerCase(), { "font-size": 11, opacity: 0.8 })
    );
    el.setAttribute("aria-label", rows.map((x) => `${x.label} ${pf.format(x.value)}%`).join(", "));
    el.append(svg);
  }

  function legend(ul, rows) {
    ul.replaceChildren(...rows.map((row) => {
      const li = document.createElement("li");
      const key = document.createElement("span");
      key.className = "key";
      key.style.background = row.color;
      const label = document.createElement("span");
      label.textContent = row.label;
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `${pf.format(row.value)}%`;
      li.append(key, label, val);
      return li;
    }));
  }

  function titleCase(s) {
    return String(s).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function countryName(code) {
    try { return (regionNames && regionNames.of(code)) || code; } catch { return code; }
  }

  // ---------- charts ----------

  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = css("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function tooltipStyle() {
    return {
      backgroundColor: css("--tooltip-bg"),
      borderColor: "rgba(255, 255, 255, 0.2)",
      borderWidth: 1,
      titleColor: css("--ink-2"),
      titleFont: { weight: "normal", family: CHART_FONT },
      bodyColor: css("--ink"),
      bodyFont: { weight: "600", family: CHART_FONT },
      padding: 10,
      boxWidth: 12,
      boxHeight: 2,
      displayColors: true,
      caretSize: 0,
    };
  }

  // Compact y-axis labels with just enough digits that neighbouring ticks differ
  // (a total-views axis spanning 1.10–1.12 Cr needs more digits than 50K–52K).
  function compactTick(value, index, ticks) {
    for (let digits = 2; digits <= 6; digits++) {
      const f = new Intl.NumberFormat(CONFIG.locale, { notation: "compact", maximumSignificantDigits: digits });
      const labels = ticks.map((t) => f.format(t.value));
      if (new Set(labels).size === labels.length) return f.format(value);
    }
    return nf.format(value);
  }

  function axisCommon() {
    return {
      ticks: { color: css("--muted"), font: { size: 12, family: CHART_FONT } },
      border: { color: css("--axis") },
    };
  }

  function lineChart(key, canvas, data, unit, xMin, xMax, colorVar) {
    state.charts[key]?.destroy();
    state.charts[key] = null;

    // A line needs two snapshots; until then explain why the chart is blank.
    const box = canvas.parentElement;
    let empty = box.querySelector(".chart-empty");
    if (data.length < 2 || data[data.length - 1].x - data[0].x < 30 * 60e3) {
      if (!empty) {
        empty = document.createElement("p");
        empty.className = "chart-empty";
        box.append(empty);
      }
      const since = state.history.length ? dateTimeFmt.format(state.history[0].t) : null;
      empty.textContent = since
        ? `Tracking started ${since}. This chart fills in as the automatic updates run.`
        : "No history yet. This chart fills in as the automatic updates run.";
      canvas.hidden = true;
      return;
    }
    empty?.remove();
    canvas.hidden = false;
    const color = css(colorVar);
    const spanMs = data.length ? xMax - (xMin ?? data[0].x) : 0;
    const tick = (v) => (spanMs <= 2 * DAY ? timeFmt.format(v) : dayFmt.format(v));
    const axis = axisCommon();
    state.charts[key] = new Chart(canvas, {
      type: "line",
      data: {
        datasets: [{
          label: unit,
          data,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: color,
          pointHoverBorderColor: css("--point-ring"),
          pointHoverBorderWidth: 2,
          tension: 0,
        }],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(),
            callbacks: {
              title: (items) => dateTimeFmt.format(items[0].parsed.x),
              label: (item) => `${fmt(item.parsed.y)} ${unit}`,
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: xMin,
            max: xMax,
            grid: { display: false },
            border: axis.border,
            ticks: { ...axis.ticks, maxTicksLimit: 6, maxRotation: 0, callback: tick },
          },
          y: {
            grid: { color: css("--grid") },
            border: { display: false },
            ticks: { ...axis.ticks, maxTicksLimit: 5, callback: compactTick },
          },
        },
      },
      plugins: [crosshair],
    });
  }

  function dailyChart(daily) {
    state.charts.daily?.destroy();
    const color = css("--bar");
    const axis = axisCommon();
    state.charts.daily = new Chart($("c-daily"), {
      type: "bar",
      data: {
        labels: daily.map((d) => dayFmt.format(Date.parse(d.date))),
        datasets: [{
          label: "views",
          data: daily.map((d) => d.views),
          backgroundColor: color,
          hoverBackgroundColor: color,
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "start",
          maxBarThickness: 28,
          categoryPercentage: 0.9,
          barPercentage: 0.9,
        }],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(),
            callbacks: {
              title: (items) => dateFmt.format(Date.parse(daily[items[0].dataIndex].date)),
              label: (item) => `${fmt(item.parsed.y)} views`,
              afterBody: (items) => {
                const d = daily[items[0].dataIndex];
                return [
                  `${fmt(d.watchMinutes / 60)} watch hours`,
                  `${signed(d.subscribersGained - d.subscribersLost)} subscribers`,
                ];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: axis.border, ticks: { ...axis.ticks, maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, grid: { color: css("--grid") }, border: { display: false }, ticks: { ...axis.ticks, maxTicksLimit: 5, callback: compactTick } },
        },
      },
    });
  }

  // ---------- wiring ----------

  function init() {
    if (window.Chart) {
      Chart.defaults.font.family = CHART_FONT;
    } else {
      showNotice("error", "The chart library failed to load. Check your internet connection and reload the page.");
      return;
    }

    $("refresh-btn").addEventListener("click", refreshLive);
    document.querySelectorAll("[data-range]").forEach((b) =>
      b.addEventListener("click", () => {
        state.range = b.dataset.range;
        renderGrowth();
      })
    );
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

    loadData();
    setInterval(loadData, CONFIG.autoReloadMinutes * 60e3);
    // Keep "updated N min ago" honest between reloads.
    setInterval(() => state.latest && renderHeader(), 60e3);
  }

  init();
})();
