"use strict";

/* Citation history: reads ../assets/scholar-history.json (written by
   scripts/update_scholar.py) and draws totals and per-paper changes.
   No libraries; charts are plain SVG. Times are Pacific. */

const HISTORY_URL = "../assets/scholar-history.json";
const DAY = 864e5;
const TZ = "America/Los_Angeles";
const NS = "http://www.w3.org/2000/svg";
const $ = id => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const fmt = new Intl.NumberFormat("en-US");
const pct = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const inTz = options => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...options });
const F = {
  day: inTz({ month: "short", day: "numeric" }),
  dayYear: inTz({ month: "short", day: "numeric", year: "numeric" }),
  time: inTz({ hour: "numeric", minute: "2-digit" }),
  full: inTz({ weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
  year: inTz({ year: "numeric" }),
};
const UTC = {
  day: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
  dayYear: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }),
  month: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }),
  monthYear: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }),
};
const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Pacific calendar day as a whole number of days since 1970-01-01. */
function pacificDay(time) {
  const p = {};
  for (const part of dayParts.formatToParts(time)) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day) / DAY;
}
const dayDate = day => new Date(day * DAY);
const isInt = Number.isSafeInteger;
const signed = n => n == null ? "—" : n > 0 ? "+" + fmt.format(n) : n < 0 ? "−" + fmt.format(-n) : "0";
const tone = n => n > 0 ? "up" : n < 0 ? "down" : "";
const plural = (n, one, many = one + "s") => fmt.format(n) + " " + (n === 1 ? one : many);
function shortTitle(title) {
  const colon = title.indexOf(":");
  if (colon > 1 && colon <= 30) return title.slice(0, colon);
  const words = title.split(/\s+/);
  return words.length > 4 ? words.slice(0, 4).join(" ") + "…" : title;
}

const RANGES = [
  { key: "7d", label: "7D", days: 7, name: "7 days" },
  { key: "30d", label: "30D", days: 30, name: "30 days" },
  { key: "6m", label: "6M", days: 182, name: "6 months" },
  { key: "1y", label: "1Y", days: 365, name: "year" },
  { key: "all", label: "All", days: Infinity, name: "all time" },
  { key: "custom", label: "Custom" },
];

const S = {
  range: "30d", mode: "total", paper: null, from: 0, to: 0, start: 0, end: 0, clipped: false,
  sort: "delta", search: "", changedOnly: false,
};
let D = null;
let uid = 0;

/* ------------------------------------------------------------------ data */

async function load() {
  const response = await fetch(HISTORY_URL, { cache: "no-store" });
  if (!response.ok) throw new Error("The history file could not be read (" + response.status + ").");
  const raw = await response.json();
  if (raw.schema_version !== 1 || !Array.isArray(raw.snapshots)) throw new Error("The history file has an unknown format.");
  const caps = raw.snapshots
    .map(s => ({ ...s, time: Date.parse(s.at) }))
    .filter(s => isInt(s.citations) && Number.isFinite(s.time))
    .sort((a, b) => a.time - b.time);
  if (!caps.length) throw new Error("The history file has no captures yet.");
  caps.forEach((c, i) => {
    c.i = i;
    c.day = pacificDay(c.time);
    if (!c.counts || typeof c.counts !== "object") delete c.counts;
  });
  D = {
    author: raw.author || "tVb54uUAAAAJ",
    papers: raw.papers || {},
    yearly: raw.yearly && Object.keys(raw.yearly).length ? raw.yearly : null,
    yearlyAt: raw.yearly_at ? Date.parse(raw.yearly_at) : null,
    sample: raw.sample === true,
    caps,
    paperCaps: caps.filter(c => c.counts),
  };
}

const valueOf = (cap, paper = S.paper) => paper ? cap.counts?.[paper] : cap.citations;
const titleOf = id => D.papers[id]?.title || id;
const scholarUrl = id => "https://scholar.google.com/citations?" + new URLSearchParams({
  view_op: "view_citation", hl: "en", user: D.author, citation_for_view: id.includes(":") ? id : D.author + ":" + id,
});

function setRange(key) {
  S.range = key;
  const caps = D.caps, last = caps.length - 1;
  if (key === "custom") {
    S.from = Math.min(S.from, Math.max(0, S.to - 1));
    S.start = caps[S.from].time;
    S.end = caps[S.to].time;
    S.clipped = false;
    return;
  }
  const range = RANGES.find(r => r.key === key);
  S.to = last;
  S.end = caps[last].time;
  const target = range.days === Infinity ? -Infinity : S.end - range.days * DAY;
  let from = -1;
  for (let i = last - 1; i >= 0; i--) if (caps[i].time <= target) { from = i; break; }
  S.clipped = from < 0 && range.days !== Infinity;
  S.from = Math.max(0, from);
  S.start = from < 0 ? caps[0].time : target;
}

/** Paper counts at the start and end of the window. */
function paperWindow() {
  const fromTime = D.caps[S.from].time, toTime = D.caps[S.to].time;
  let before = null, after = null;
  for (const c of D.paperCaps) {
    if (c.time <= fromTime) before = c;
    if (c.time <= toTime) after = c;
  }
  let partial = false;
  if (!before && after) {
    before = D.paperCaps.find(c => c.time > fromTime && c.time <= toTime) || null;
    partial = true;
  }
  const comparable = Boolean(before && after && before !== after);
  return { before, after, partial, comparable };
}

function paperRows() {
  const win = paperWindow();
  const rows = [];
  if (win.after) {
    for (const [id, count] of Object.entries(win.after.counts)) {
      if (!isInt(count)) continue;
      const meta = D.papers[id] || {};
      const prev = win.comparable ? win.before.counts[id] : undefined;
      const isNew = win.comparable && !isInt(prev);
      const delta = !win.comparable ? null : isNew ? count : count - prev;
      rows.push({
        id, count, prev, delta, isNew, title: meta.title || id, year: meta.year, venue: meta.venue,
        growth: isInt(prev) && prev > 0 ? delta / prev : null,
      });
    }
  }
  const gained = rows.reduce((sum, r) => sum + Math.max(0, r.delta || 0), 0);
  return { ...win, rows, gained };
}

/** Papers that changed between two captures that both have per-paper counts. */
function changesBetween(prev, cap) {
  if (!prev?.counts || !cap?.counts) return [];
  const out = [];
  for (const [id, count] of Object.entries(cap.counts)) {
    const before = prev.counts[id];
    const delta = isInt(before) ? count - before : count;
    if (delta) out.push({ id, delta, isNew: !isInt(before) });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

function previousWithCounts(cap) {
  for (let i = cap.i - 1; i >= 0; i--) if (D.caps[i].counts) return D.caps[i];
  return null;
}

/* --------------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function svg(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) if (value != null) node.setAttribute(key, value);
  if (parent) parent.append(node);
  return node;
}
function label(parent, x, y, text, attrs) {
  const node = svg("text", { x, y, ...attrs }, parent);
  node.textContent = text;
  return node;
}
function niceScale(lo, hi, count = 4) {
  if (!(hi > lo)) { lo = Math.max(0, lo - 1); hi = lo + 2; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw && Number.isInteger(s)) ?? 10 * mag);
  const min = Math.floor(lo / step) * step;
  const max = Math.max(min + step, Math.ceil(hi / step) * step);
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { min, max, ticks };
}
function monthName(m, withYear) {
  const date = new Date(Date.UTC(Math.floor(m / 12), m % 12, 1));
  return UTC.month.format(date) + (withYear ? " ’" + String(Math.floor(m / 12)).slice(2) : "");
}
function timeTicks(start, end, maxTicks) {
  const span = (end - start) / DAY;
  const out = [];
  if (span < 2.5) {
    for (let i = 0; i < 3; i++) {
      const t = start + (end - start) * (i + .5) / 3;
      out.push({ t, text: F.day.format(t) + ", " + F.time.format(t) });
    }
    return out;
  }
  const d0 = pacificDay(start), d1 = pacificDay(end);
  const midnight = day => day * DAY + 8 * 3600e3;
  if (span <= 80) {
    const step = [1, 2, 3, 7, 14, 21].find(s => span / s <= maxTicks) || 28;
    let first = d0 + 1;
    if (step >= 7) first = d0 + (((4 - d0) % 7) + 7) % 7 || d0 + 7;
    for (let d = first; d <= d1; d += step) {
      const t = midnight(d);
      if (t > start && t < end) out.push({ t, text: UTC.day.format(dayDate(d)) });
    }
    return out;
  }
  const s = dayDate(d0), e = dayDate(d1);
  let m = s.getUTCFullYear() * 12 + s.getUTCMonth() + 1;
  const mEnd = e.getUTCFullYear() * 12 + e.getUTCMonth();
  const step = [1, 2, 3, 6, 12].find(k => (mEnd - m + 1) / k <= maxTicks) || 24;
  while (m % step) m++;
  for (let first = true; m <= mEnd; m += step) {
    const t = midnight(Date.UTC(Math.floor(m / 12), m % 12, 1) / DAY);
    if (t <= start || t >= end) continue;
    out.push({ t, text: monthName(m, first || m % 12 === 0) });
    first = false;
  }
  return out;
}

/** Monotone cubic through screen points (no overshoot, like d3.curveMonotoneX). */
function monotone(points) {
  const n = points.length;
  if (!n) return "";
  if (n === 1) return `M${points[0][0]},${points[0][1]}`;
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const sign = x => x < 0 ? -1 : 1;
  const slopes = [];
  for (let i = 0; i < n - 1; i++) slopes.push((ys[i + 1] - ys[i]) / ((xs[i + 1] - xs[i]) || 1e-6));
  const t = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i], s0 = slopes[i - 1], s1 = slopes[i];
    const p = (s0 * h1 + s1 * h0) / ((h0 + h1) || 1e-6);
    t[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), .5 * Math.abs(p)) || 0;
  }
  const end = (s, inner) => {
    const v = n > 2 ? (3 * s - inner) / 2 : s;
    return s === 0 || sign(v) !== sign(s) ? 0 : Math.abs(v) > 3 * Math.abs(s) ? 3 * s : v;
  };
  t[0] = end(slopes[0], t[1]);
  t[n - 1] = end(slopes[n - 2], t[n - 2]);
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    d += `C${xs[i] + dx},${ys[i] + dx * t[i]} ${xs[i + 1] - dx},${ys[i + 1] - dx * t[i + 1]} ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}
function barPath(x, y0, y1, w) {
  const top = Math.min(y0, y1), h = Math.abs(y1 - y0), r = Math.min(4, w / 2, h);
  if (y1 <= y0) return `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y0}Z`;
  const bottom = top + h;
  return `M${x},${top}V${bottom - r}Q${x},${bottom} ${x + r},${bottom}H${x + w - r}Q${x + w},${bottom} ${x + w},${bottom - r}V${top}Z`;
}
function drawIn(path, animate, delay = 0) {
  if (!animate || reduceMotion) return;
  const length = path.getTotalLength();
  path.style.setProperty("--len", length);
  path.style.strokeDasharray = length;
  path.style.animationDelay = delay + "ms";
  path.classList.add("anim-draw");
}
function animateClass(node, animate, name, delay) {
  if (!animate || reduceMotion) return;
  node.classList.add(name);
  node.style.animationDelay = Math.round(delay) + "ms";
}
function countTo(node, value, format = n => fmt.format(n)) {
  const from = Number(node.dataset.value ?? value);
  node.dataset.value = value;
  if (reduceMotion || from === value) { node.textContent = format(value); return; }
  const start = performance.now(), duration = 900;
  const step = now => {
    const k = Math.min(1, (now - start) / duration), eased = 1 - (1 - k) ** 3;
    node.textContent = format(Math.round(from + (value - from) * eased));
    if (k < 1 && node.dataset.value == value) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function emptyPlot(target, text) {
  target.replaceChildren(el("p", "empty", text));
}
function frame(target, height) {
  const width = Math.max(280, Math.floor(target.clientWidth));
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" });
  const defs = svg("defs", {}, root);
  const id = "wash" + ++uid;
  const gradient = svg("linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
  svg("stop", { offset: "0%", "stop-color": "var(--series)", "stop-opacity": .16 }, gradient);
  svg("stop", { offset: "100%", "stop-color": "var(--series)", "stop-opacity": 0 }, gradient);
  target.replaceChildren(root);
  return { root, width, height, wash: `url(#${id})` };
}

/* ---------------------------------------------------------------- tooltip */

const tip = $("tip");
function showTip(x, y, build) {
  tip.replaceChildren();
  build(tip);
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.min(Math.max(x, w / 2 + 8), innerWidth - w / 2 - 8);
  const below = y - h - 18 < 8;
  tip.style.left = left + "px";
  tip.style.top = y + "px";
  tip.style.transform = below ? "translate(-50%, 16px)" : "translate(-50%, calc(-100% - 14px))";
}
function hideTip() { tip.hidden = true; }
addEventListener("scroll", hideTip, { passive: true });
function tipHead(box, when, value, unit, title) {
  box.append(el("div", "t-when", when));
  if (title) box.append(el("div", "t-title", title));
  const v = el("div", "t-val", value);
  if (unit) v.append(el("small", null, unit));
  box.append(v);
}
function tipList(box, items) {
  if (!items.length) return;
  const list = el("ul");
  for (const [name, value] of items) {
    const li = el("li");
    const strong = el("b", null, value);
    if (/^0$|^—$/.test(value)) strong.style.color = "var(--muted)";
    else if (value.startsWith("−")) strong.style.color = "var(--down)";
    li.append(el("span", null, name), strong);
    list.append(li);
  }
  box.append(list);
}

/* ------------------------------------------------------------ main chart */

function linePoints() {
  const pts = [];
  const base = D.caps[S.from], v0 = valueOf(base);
  if (isInt(v0)) pts.push({ t: S.start, v: v0, cap: base, carried: base.time < S.start });
  for (let i = S.from + 1; i <= S.to; i++) {
    const v = valueOf(D.caps[i]);
    if (isInt(v)) pts.push({ t: D.caps[i].time, v, cap: D.caps[i] });
  }
  return pts;
}

function chartHeight(target, desktop, mobile) {
  return target.clientWidth < 560 ? mobile : desktop;
}

function drawLine(target, animate) {
  const pts = linePoints();
  if (!pts.length) {
    emptyPlot(target, "No counts for this paper in this window yet.");
    return;
  }
  const f = frame(target, chartHeight(target, 320, 240));
  const m = { l: 46, r: 64, t: 18, b: 30 };
  const x0 = S.start, x1 = S.end > S.start ? S.end : S.start + DAY;
  const values = pts.map(p => p.v);
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(1, (hi - lo) * .08);
  const ys = niceScale(Math.max(0, lo - pad), hi + pad, f.height < 300 ? 3 : 4);
  const X = t => m.l + (t - x0) / (x1 - x0) * (f.width - m.l - m.r);
  const Y = v => f.height - m.b - (v - ys.min) / (ys.max - ys.min) * (f.height - m.t - m.b);
  const focus = S.paper ? " focus" : "";
  f.root.setAttribute("aria-label", (S.paper ? titleOf(S.paper) : "Total citations") + ", " + F.day.format(x0) + " to " + F.day.format(x1));

  const grid = svg("g", { class: "grid" }, f.root);
  for (const v of ys.ticks) {
    svg("line", { x1: m.l, x2: f.width - m.r, y1: Y(v), y2: Y(v) }, grid);
    label(f.root, m.l - 10, Y(v) + 4, fmt.format(v), { "text-anchor": "end" });
  }
  for (const tick of timeTicks(x0, x1, f.width < 560 ? 3 : 6)) {
    label(f.root, X(tick.t), f.height - 8, tick.text, { "text-anchor": "middle" });
  }

  const screen = [];
  for (const p of pts) {
    const sx = X(p.t);
    if (screen.length && Math.abs(screen.at(-1)[0] - sx) < .5) screen.pop();
    screen.push([sx, Y(p.v)]);
  }
  const d = monotone(screen);
  const last = screen.at(-1), first = screen[0];
  if (!S.paper) {
    svg("path", { d: d + `L${last[0]},${f.height - m.b}L${first[0]},${f.height - m.b}Z`, class: "area", fill: f.wash }, f.root);
  }
  const line = svg("path", { d, class: "line" + focus }, f.root);
  drawIn(line, animate);

  // Few checks: a dot for each. Many: dots only where the count changed.
  const dense = pts.length > 30;
  const rises = pts.filter((p, i) => i && p.v !== pts[i - 1].v).length;
  pts.forEach((p, i) => {
    if (p.carried || i === pts.length - 1 || (dense && (rises > 32 || !(i && p.v !== pts[i - 1].v)))) return;
    const dot = svg("circle", { cx: X(p.t), cy: Y(p.v), r: dense ? 3 : 3.4, class: "pt" + focus }, f.root);
    animateClass(dot, animate, "anim-pop", 250 + i / pts.length * 900);
  });
  const end = pts.at(-1);
  const halo = svg("circle", { cx: last[0], cy: last[1], r: 5, class: "halo" + focus }, f.root);
  if (!animate || reduceMotion) halo.style.animationDelay = "0s";
  const endDot = svg("circle", { cx: last[0], cy: last[1], r: 5, class: "end" + focus }, f.root);
  animateClass(endDot, animate, "anim-pop", 1000);
  const endText = label(f.root, last[0] + 10, last[1] + 4, fmt.format(end.v), { class: "end-label" });
  animateClass(endText, animate, "anim-fade", 1050);
  const change = end.v - pts[0].v;
  if (pts.length > 1) {
    const sub = label(f.root, last[0] + 10, last[1] + 19, signed(change), { class: "end-label sub" });
    animateClass(sub, animate, "anim-fade", 1150);
  }

  // Hover: a crosshair that snaps to the nearest saved check.
  const hair = svg("line", { y1: m.t - 6, y2: f.height - m.b, class: "hair", visibility: "hidden" }, f.root);
  const ring = svg("circle", { r: 5.5, class: "hover-dot" + focus, visibility: "hidden" }, f.root);
  const hit = svg("rect", { x: m.l, y: 0, width: f.width - m.l - m.r + 12, height: f.height - m.b, class: "hit" }, f.root);
  const hide = () => { hair.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); hideTip(); };
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("pointermove", event => {
    const box = f.root.getBoundingClientRect();
    const px = (event.clientX - box.left) * f.width / box.width;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(X(pts[i].t) - px) < Math.abs(X(pts[best].t) - px)) best = i;
    const p = pts[best], cx = X(p.t), cy = Y(p.v);
    hair.setAttribute("x1", cx); hair.setAttribute("x2", cx); hair.setAttribute("visibility", "visible");
    ring.setAttribute("cx", cx); ring.setAttribute("cy", cy); ring.setAttribute("visibility", "visible");
    const prev = best > 0 ? pts[best - 1] : null;
    showTip(box.left + cx * box.width / f.width, box.top + cy * box.height / f.height, tipBox => {
      const when = p.carried ? "Start of window · " + F.dayYear.format(p.t) : F.full.format(p.cap.time) + " PT";
      tipHead(tipBox, when, fmt.format(p.v), S.paper ? "citations" : "total citations");
      const rows = [];
      if (prev) rows.push(["Since previous check", signed(p.v - prev.v)]);
      if (!S.paper && !p.carried) {
        const changes = changesBetween(previousWithCounts(p.cap), p.cap).slice(0, 4);
        for (const c of changes) rows.push([shortTitle(titleOf(c.id)), signed(c.delta)]);
      }
      tipList(tipBox, rows);
    });
  });
}

function gainBuckets() {
  const span = (S.end - S.start) / DAY;
  const unit = span <= 62 ? "day" : span <= 420 ? "week" : "month";
  const keyOf = day => {
    if (unit === "day") return day;
    if (unit === "week") return Math.floor((day - 4) / 7);
    const date = dayDate(day);
    return date.getUTCFullYear() * 12 + date.getUTCMonth();
  };
  const startKey = keyOf(pacificDay(S.start)), endKey = keyOf(D.caps[S.to].day);
  let prev = valueOf(D.caps[S.from]);
  if (!isInt(prev)) prev = undefined;
  const series = [];
  for (let i = S.from + 1; i <= S.to; i++) {
    const v = valueOf(D.caps[i]);
    if (isInt(v)) series.push({ k: keyOf(D.caps[i].day), v });
  }
  const buckets = [];
  let j = 0;
  for (let k = startKey; k <= endKey; k++) {
    let last, checks = 0;
    while (j < series.length && series[j].k <= k) { last = series[j].v; checks++; j++; }
    const gain = last !== undefined ? (prev !== undefined ? last - prev : null) : (prev !== undefined ? 0 : null);
    buckets.push({ k, gain, checks });
    if (last !== undefined) prev = last;
  }
  const nowKey = keyOf(pacificDay(Date.now()));
  const describe = k => unit === "day" ? UTC.dayYear.format(dayDate(k))
    : unit === "week" ? "Week of " + UTC.dayYear.format(dayDate(k * 7 + 4))
    : UTC.monthYear.format(new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)));
  const axis = (k, i) => unit === "day" ? UTC.day.format(dayDate(k))
    : unit === "week" ? UTC.day.format(dayDate(k * 7 + 4)) : monthName(k, i === 0 || k % 12 === 0);
  return { unit, buckets, nowKey, describe, axis };
}

function drawBars(target, animate) {
  const g = gainBuckets();
  const known = g.buckets.filter(b => b.gain != null);
  if (!known.length) {
    emptyPlot(target, "Gains need two checks in this window.");
    return;
  }
  const f = frame(target, chartHeight(target, 320, 240));
  const m = { l: 46, r: 16, t: 22, b: 30 };
  const gains = known.map(b => b.gain);
  const ys = niceScale(Math.min(0, ...gains), Math.max(1, ...gains), f.height < 300 ? 3 : 4);
  const n = g.buckets.length, slot = (f.width - m.l - m.r) / n;
  const w = Math.max(2, Math.min(24, slot * .7));
  const Y = v => f.height - m.b - (v - ys.min) / (ys.max - ys.min) * (f.height - m.t - m.b);
  const focus = S.paper ? " focus" : "";
  f.root.setAttribute("aria-label", "Citations gained per " + g.unit);

  const grid = svg("g", { class: "grid" }, f.root);
  for (const v of ys.ticks) {
    svg("line", { x1: m.l, x2: f.width - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? "zero" : null }, grid);
    label(f.root, m.l - 10, Y(v) + 4, fmt.format(v), { "text-anchor": "end" });
  }
  const every = Math.max(1, Math.ceil(n / (f.width < 560 ? 4 : 7)));
  g.buckets.forEach((b, i) => {
    if ((n - 1 - i) % every === 0) {
      label(f.root, m.l + slot * (i + .5), f.height - 8, g.axis(b.k, i), { "text-anchor": "middle" });
    }
  });

  const maxGain = Math.max(...gains);
  let maxLabelled = false;
  const bars = [];
  g.buckets.forEach((b, i) => {
    const x = m.l + slot * i + (slot - w) / 2;
    if (b.gain) {
      const partial = i === n - 1 && b.k === g.nowKey && g.unit !== "day";
      const bar = svg("path", {
        d: barPath(x, Y(0), Y(b.gain), w),
        class: "bar" + focus + (b.gain < 0 ? " neg" : "") + (partial ? " partial" : ""),
      }, f.root);
      animateClass(bar, animate, "anim-grow", Math.min(700, i * (700 / n)));
      bars.push(bar);
      if ((b.gain === maxGain && !maxLabelled) || (i === n - 1 && b.gain > 0 && n > 1)) {
        if (b.gain === maxGain) maxLabelled = true;
        const t = label(f.root, x + w / 2, Y(b.gain) - 7, signed(b.gain), { "text-anchor": "middle", class: "end-label sub" });
        animateClass(t, animate, "anim-fade", 700);
      }
    }
    const hit = svg("rect", { x: m.l + slot * i, y: m.t - 10, width: slot, height: f.height - m.t - m.b + 10, class: "hit" }, f.root);
    hit.addEventListener("pointerenter", () => {
      bars.forEach(node => node.classList.add("dim"));
      const box = f.root.getBoundingClientRect();
      const mine = b.gain ? bars[g.buckets.slice(0, i).filter(x => x.gain).length] : null;
      if (mine) mine.classList.remove("dim");
      const top = Y(Math.max(0, b.gain || 0));
      showTip(box.left + (x + w / 2) * box.width / f.width, box.top + top * box.height / f.height, tipBox => {
        tipHead(tipBox, g.describe(b.k), b.gain == null ? "—" : signed(b.gain), "citations");
        tipList(tipBox, [[b.checks ? plural(b.checks, "check") : "No check", b.gain == null ? "before tracking" : ""]]);
      });
    });
    hit.addEventListener("pointerleave", () => { bars.forEach(node => node.classList.remove("dim")); hideTip(); });
  });
  return g.unit;
}

function shortVenue(venue) {
  return venue.replace(/,?\s*\d{4}$/, "").replace(/^arXiv preprint arXiv:.*/i, "arXiv").slice(0, 60);
}

function renderMain(animate) {
  const target = $("main-plot");
  const paper = S.paper ? D.papers[S.paper] || {} : null;
  let unit = null;
  if (S.mode === "gains") unit = drawBars(target, animate);
  else drawLine(target, animate);
  $("main-title").textContent = paper ? titleOf(S.paper)
    : S.mode === "gains" ? "Citations gained per " + (unit || "day") : "Total citations";
  const meta = $("main-meta");
  meta.hidden = !paper;
  if (paper) {
    const parts = [];
    if (paper.year) parts.push(el("span", null, String(paper.year)));
    if (paper.venue) parts.push(el("span", "v", shortVenue(paper.venue)));
    if (!D.sample) {
      const link = el("a", null, "Google Scholar");
      link.href = scholarUrl(S.paper);
      parts.push(link);
    }
    meta.replaceChildren(...parts);
  }
}

/* ------------------------------------------------------------ year chart */

function renderYears(animate) {
  const target = $("years-plot");
  const paper = S.paper ? D.papers[S.paper] : null;
  const yearly = paper ? paper.yearly : D.yearly;
  const savedAt = paper ? (paper.yearly_at ? Date.parse(paper.yearly_at) : null) : D.yearlyAt;
  $("years-aside").textContent = paper ? shortTitle(paper.title || S.paper) : "";
  const entries = yearly ? Object.entries(yearly).map(([y, v]) => [Number(y), v])
    .filter(([y, v]) => y > 1900 && isInt(v)).sort((a, b) => a[0] - b[0]) : [];
  if (!entries.length) {
    emptyPlot(target, paper ? "Not saved for this paper yet." : "Saved with the next check.");
    return;
  }
  const f = frame(target, 240);
  const m = { l: 36, r: 8, t: 22, b: 26 };
  const ys = niceScale(0, Math.max(1, ...entries.map(e => e[1])), 3);
  const n = entries.length, slot = (f.width - m.l - m.r) / n, w = Math.max(4, Math.min(24, slot * .62));
  const Y = v => f.height - m.b - (v - ys.min) / (ys.max - ys.min) * (f.height - m.t - m.b);
  const thisYear = Number(F.year.format(savedAt || Date.now()));
  const focus = paper ? " focus" : "";
  f.root.setAttribute("aria-label", "Citations per year");
  const grid = svg("g", { class: "grid" }, f.root);
  for (const v of ys.ticks) {
    svg("line", { x1: m.l, x2: f.width - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? "zero" : null }, grid);
    label(f.root, m.l - 8, Y(v) + 4, fmt.format(v), { "text-anchor": "end" });
  }
  const showAll = n <= 8;
  const max = Math.max(...entries.map(e => e[1]));
  const every = Math.max(1, Math.ceil(n / 8));
  entries.forEach(([year, value], i) => {
    const x = m.l + slot * i + (slot - w) / 2;
    if ((n - 1 - i) % every === 0) label(f.root, x + w / 2, f.height - 7, String(year), { "text-anchor": "middle" });
    if (value) {
      const partial = year === thisYear;
      const bar = svg("path", { d: barPath(x, Y(0), Y(value), w), class: "bar" + focus + (partial ? " partial" : "") }, f.root);
      animateClass(bar, animate, "anim-grow", i * 60);
      if (showAll || value === max || i === n - 1) {
        const t = label(f.root, x + w / 2, Y(value) - 6, fmt.format(value), { "text-anchor": "middle", class: "end-label sub" });
        animateClass(t, animate, "anim-fade", 450 + i * 60);
      }
    }
    const hit = svg("rect", { x: m.l + slot * i, y: m.t - 10, width: slot, height: f.height - m.t - m.b + 10, class: "hit" }, f.root);
    hit.addEventListener("pointerenter", () => {
      const box = f.root.getBoundingClientRect();
      showTip(box.left + (x + w / 2) * box.width / f.width, box.top + Y(value) * box.height / f.height, tipBox => {
        tipHead(tipBox, year === thisYear ? year + " so far" : String(year), fmt.format(value), "citations");
      });
    });
    hit.addEventListener("pointerleave", hideTip);
  });
}

/* ---------------------------------------------------------------- scatter */

function renderScatter(model, animate) {
  const target = $("scatter-plot");
  if (!model.rows.length) { emptyPlot(target, "Per-paper counts start with the next check."); return; }
  if (!model.comparable) { emptyPlot(target, "Needs a second per-paper check."); return; }
  const f = frame(target, 240);
  const m = { l: 36, r: 14, t: 18, b: 26 };
  const rows = model.rows;
  const maxCount = Math.max(10, ...rows.map(r => r.count));
  const lx = v => Math.log10(v + 1);
  const xMax = Math.ceil(lx(maxCount) * 10) / 10;
  const ys = niceScale(Math.min(0, ...rows.map(r => r.delta)), Math.max(2, ...rows.map(r => r.delta)), 3);
  const X = v => m.l + lx(v) / xMax * (f.width - m.l - m.r);
  const Y = v => f.height - m.b - (v - ys.min) / (ys.max - ys.min) * (f.height - m.t - m.b);
  f.root.setAttribute("aria-label", "Papers by total citations and citations gained");
  const grid = svg("g", { class: "grid" }, f.root);
  for (const v of ys.ticks) {
    svg("line", { x1: m.l, x2: f.width - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? "zero" : null }, grid);
    label(f.root, m.l - 8, Y(v) + 4, signed(v), { "text-anchor": "end" });
  }
  for (const v of [0, 10, 100, 1000, 10000]) {
    if (lx(v) > xMax) break;
    if (X(v) < f.width - m.r - 56) label(f.root, X(v), f.height - 7, fmt.format(v), { "text-anchor": "middle" });
  }
  label(f.root, f.width - m.r, f.height - 7, "total →", { "text-anchor": "end", class: "axis-title" });
  label(f.root, m.l - 8, m.t - 8, "gained", { "text-anchor": "start", class: "axis-title" });

  const ranked = [...rows].sort((a, b) => a.delta - b.delta || a.count - b.count);
  ranked.forEach((r, i) => {
    const cx = X(r.count), cy = Y(r.delta), on = r.id === S.paper;
    const hit = svg("circle", { cx, cy, r: 12, class: "dot-hit" }, f.root);
    const dot = svg("circle", { cx, cy, r: on ? 7 : 5, class: "dot" + (on ? " focus" : r.delta > 0 ? " hot" : "") }, f.root);
    animateClass(dot, animate, "anim-pop", 120 + i * (600 / ranked.length));
    for (const node of [hit, dot]) {
      node.addEventListener("click", () => selectPaper(r.id === S.paper ? null : r.id));
      node.addEventListener("pointerenter", () => {
        const box = f.root.getBoundingClientRect();
        showTip(box.left + cx * box.width / f.width, box.top + cy * box.height / f.height, tipBox => {
          tipHead(tipBox, r.year ? String(r.year) : "Paper", signed(r.delta), "in this window", r.title);
          tipList(tipBox, [["Citations now", fmt.format(r.count)]]);
        });
      });
      node.addEventListener("pointerleave", hideTip);
    }
  });

  // Direct labels for the followed paper and the top gainers, skipping any that would collide.
  const labelled = rows.filter(r => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3).map(r => r.id);
  if (S.paper) labelled.unshift(S.paper);
  // Dots count as obstacles too, so a label never sits on another paper's dot.
  const placed = rows.map(r => ({ x: X(r.count) - 5, y: Y(r.delta) - 5, width: 10, height: 10, id: r.id }));
  const overlaps = (a, b) => a.x < b.x + b.width + 4 && b.x < a.x + a.width + 4 && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const id of [...new Set(labelled)]) {
    const r = rows.find(row => row.id === id);
    if (!r) continue;
    const cx = X(r.count), cy = Y(r.delta), right = cx < f.width - 120, dx = right ? 11 : -11;
    for (const [x, y] of [[cx + dx, cy + 4], [cx + dx, cy - 9], [cx + dx, cy + 17]]) {
      const t = label(f.root, x, y, shortTitle(r.title), { class: "dot-label" + (id === S.paper ? " on" : ""), "text-anchor": right ? "start" : "end" });
      const box = t.getBBox();
      if (box.y < 0 || box.y + box.height > f.height - m.b + 4
        || placed.some(other => other.id !== id && overlaps(box, other))) { t.remove(); continue; }
      placed.push(box);
      animateClass(t, animate, "anim-fade", 700);
      break;
    }
  }
}

/* ------------------------------------------------------------------ table */

function sparkline(id) {
  const values = [];
  for (let i = S.from; i <= S.to; i++) {
    const v = D.caps[i].counts?.[id];
    if (isInt(v)) values.push(v);
  }
  const node = svg("svg", { class: "spark", viewBox: "0 0 112 28", "aria-hidden": "true" });
  if (values.length < 2) return node;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => [2 + i / (values.length - 1) * 106, hi === lo ? 18 : 24 - (v - lo) / (hi - lo) * 20]);
  const d = monotone(pts);
  svg("path", { d: d + `L${pts.at(-1)[0]},28L${pts[0][0]},28Z`, class: "spark-area" }, node);
  node.append(svg("path", { d }));
  svg("circle", { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 2.2 }, node);
  return node;
}

function renderTable(model) {
  const tools = $("paper-tools"), wrap = $("papers-wrap"), empty = $("papers-empty");
  $("papers-aside").textContent = model.rows.length
    ? plural(model.rows.length, "paper") + (model.partial && model.comparable ? " · since " + F.day.format(model.before.time) : "")
    : "";
  if (!model.rows.length) {
    tools.hidden = true; wrap.hidden = true; empty.hidden = false;
    empty.textContent = "Per-paper counts start with the next check.";
    return;
  }
  tools.hidden = false;
  const phrase = S.search.trim().toLowerCase();
  const rows = model.rows.filter(r => (!phrase || r.title.toLowerCase().includes(phrase)) && (!S.changedOnly || r.delta));
  const by = {
    delta: (a, b) => (b.delta ?? -1) - (a.delta ?? -1) || b.count - a.count,
    count: (a, b) => b.count - a.count || (b.delta ?? 0) - (a.delta ?? 0),
    growth: (a, b) => (b.growth ?? -1) - (a.growth ?? -1) || (b.delta ?? 0) - (a.delta ?? 0),
  };
  rows.sort(by[S.sort]);
  for (const button of document.querySelectorAll("th button")) button.setAttribute("aria-pressed", String(button.dataset.sort === S.sort));
  wrap.hidden = !rows.length;
  empty.hidden = Boolean(rows.length);
  if (!rows.length) empty.textContent = "No papers match.";
  const maxDelta = Math.max(1, ...rows.map(r => r.delta || 0));
  const body = document.createDocumentFragment();
  rows.forEach((r, i) => {
    const tr = el("tr", r.id === S.paper ? "on" : "");
    tr.style.setProperty("--d", Math.min(i, 18) * 20 + "ms");
    const main = el("td", "c-title");
    const title = el("button", "p-title", r.title);
    title.type = "button";
    title.setAttribute("aria-pressed", String(r.id === S.paper));
    title.addEventListener("click", () => selectPaper(r.id === S.paper ? null : r.id, true));
    const meta = el("div", "p-meta");
    if (r.year) meta.append(el("span", null, String(r.year)));
    if (r.venue) meta.append(el("span", "v", shortVenue(r.venue)));
    main.append(title, meta);
    const trend = el("td", "c-trend");
    trend.append(sparkline(r.id));
    const count = el("td", "c-num");
    count.append(el("span", "num-big", fmt.format(r.count)));
    const change = el("td", "c-num");
    if (r.isNew) change.append(el("span", "new-tag", "new"));
    else change.append(el("span", "delta " + tone(r.delta), signed(r.delta)));
    if (r.delta > 0) {
      const share = el("span", "share");
      share.style.width = Math.max(4, r.delta / maxDelta * 72) + "px";
      share.style.setProperty("--d", Math.min(i, 18) * 20 + 200 + "ms");
      change.append(share);
    }
    const growth = el("td", "c-num c-growth delta " + tone(r.delta),
      r.growth == null ? "—" : (r.growth > 0 ? "+" : "") + pct.format(r.growth));
    tr.append(main, trend, count, change, growth);
    body.append(tr);
  });
  $("paper-rows").replaceChildren(body);
}

/* ------------------------------------------------------------- summary */

function rangeLabel() {
  if (S.range === "custom") return F.day.format(S.start) + " → " + F.day.format(S.end);
  if (S.clipped || S.range === "all") return "since " + F.day.format(D.caps[0].time);
  return "";
}

function renderTiles(model) {
  const from = D.caps[S.from], to = D.caps[S.to];
  const gain = S.from === S.to ? null : to.citations - from.citations;
  countTo($("t-total"), to.citations);

  const gainNode = $("t-gain");
  countTo(gainNode, gain ?? 0, n => gain == null ? "—" : signed(n));
  gainNode.className = "big";
  const span = Math.max(1, (S.end - S.start) / DAY);
  $("t-gain-note").textContent = gain == null ? ""
    : ["≈ " + (gain / span).toFixed(1) + " a day", rangeLabel()].filter(Boolean).join(" · ");

  countTo($("t-h"), to.h_index ?? 0, n => isInt(to.h_index) ? fmt.format(n) : "—");
  countTo($("t-i10"), to.i10_index ?? 0, n => isInt(to.i10_index) ? fmt.format(n) : "—");
  const dh = isInt(from.h_index) && isInt(to.h_index) ? to.h_index - from.h_index : 0;
  const di = isInt(from.i10_index) && isInt(to.i10_index) ? to.i10_index - from.i10_index : 0;
  const indexNote = $("t-index-note");
  indexNote.className = "note";
  indexNote.replaceChildren();
  if (S.from !== S.to && (dh || di)) {
    indexNote.append(el("span", "delta " + tone(dh), dh ? signed(dh) : "0"), " · ", el("span", "delta " + tone(di), di ? signed(di) : "0"));
  }

  const top = model.rows.filter(r => r.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  const holder = $("t-top");
  let next;
  if (top) {
    next = el("button", "big big-text");
    next.type = "button";
    next.title = top.title;
    next.append(el("span", "hl", shortTitle(top.title)));
    next.addEventListener("click", () => selectPaper(top.id, true));
    $("t-top-note").replaceChildren(el("span", "delta up", signed(top.delta)), " citations");
  } else {
    next = el("p", "big big-text", "—");
    $("t-top-note").textContent = D.paperCaps.length ? "" : "starts with the next check";
  }
  next.id = "t-top";
  holder.replaceWith(next);
}

function renderControls() {
  $("custom").hidden = S.range !== "custom";
  const chip = $("focus-chip");
  chip.hidden = !S.paper;
  if (S.paper) $("focus-name").textContent = shortTitle(titleOf(S.paper));
  for (const tabs of document.querySelectorAll(".tabs")) placeInk(tabs);
}

/* ------------------------------------------------------------------ flow */

function render({ animate = true } = {}) {
  hideTip();
  const model = paperRows();
  renderControls();
  renderTiles(model);
  renderMain(animate);
  renderYears(animate);
  renderScatter(model, animate);
  renderTable(model);
  writeHash();
}

function selectPaper(id, scroll) {
  S.paper = id && (D.papers[id] || D.paperCaps.some(c => id in c.counts)) ? id : null;
  render();
  if (scroll) {
    const top = $("main-title").getBoundingClientRect().top;
    if (top < 70 || top > innerHeight * .5) scrollTo({ top: scrollY + top - 80, behavior: reduceMotion ? "auto" : "smooth" });
    $("main-title").focus({ preventScroll: true });
  }
}

/** Slide the underline to the selected tab. */
function placeInk(tabs, instant) {
  let ink = tabs.querySelector(".ink");
  if (!ink) { ink = el("span", "ink"); tabs.append(ink); instant = true; }
  const on = tabs.querySelector('button[aria-pressed="true"]');
  if (!on) { ink.style.width = "0"; return; }
  if (instant) ink.style.transition = "none";
  ink.style.width = on.offsetWidth + "px";
  ink.style.transform = `translateX(${on.offsetLeft}px)`;
  if (instant) { ink.offsetWidth; ink.style.transition = ""; }
}

function writeHash() {
  const params = new URLSearchParams();
  if (S.range !== "30d" && S.range !== "custom") params.set("range", S.range);
  if (S.mode !== "total") params.set("view", S.mode);
  if (S.paper) params.set("paper", S.paper);
  const hash = params.toString();
  history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const range = params.get("range");
  if (RANGES.some(r => r.key === range && r.key !== "custom")) S.range = range;
  if (params.get("view") === "gains") S.mode = "gains";
  const paper = params.get("paper");
  if (paper && D.papers[paper]) S.paper = paper;
}

function fillCustomSelects() {
  const from = $("from-select"), to = $("to-select");
  const option = (cap, disabled) => {
    const o = el("option", null, F.dayYear.format(cap.time) + ", " + F.time.format(cap.time) + " · " + fmt.format(cap.citations));
    o.value = String(cap.i);
    o.disabled = disabled;
    return o;
  };
  from.replaceChildren(...D.caps.map(c => option(c, c.i >= S.to)).reverse());
  to.replaceChildren(...D.caps.map(c => option(c, c.i <= S.from)).reverse());
  from.value = String(S.from);
  to.value = String(S.to);
}

/* Theme button: same three states as the homepage (auto, light, dark). */
function setupTheme() {
  const root = document.documentElement, btn = $("theme-btn");
  const ICONS = {
    auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5v11a5.5 5.5 0 0 1 0-11Z"/></svg>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 .9v1.9M8 13.2v1.9M.9 8h1.9M13.2 8h1.9M3 3l1.35 1.35M11.65 11.65 13 13M3 13l1.35-1.35M11.65 4.35 13 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 10.3A6.1 6.1 0 0 1 5.7 2.4a6.1 6.1 0 1 0 7.9 7.9Z"/></svg>',
  };
  const NAME = { auto: "Auto (follows system)", light: "Light", dark: "Dark" };
  const NEXT = { auto: "light", light: "dark", dark: "auto" };
  let mode = root.dataset.theme || "auto";
  const paint = () => {
    btn.innerHTML = ICONS[mode];
    const text = `Theme: ${NAME[mode]} · click for ${NAME[NEXT[mode]].split(" ")[0]}`;
    btn.title = text;
    btn.setAttribute("aria-label", text);
  };
  btn.addEventListener("click", () => {
    mode = NEXT[mode];
    if (mode === "auto") { delete root.dataset.theme; try { localStorage.removeItem("theme"); } catch { /* ignore */ } }
    else { root.dataset.theme = mode; try { localStorage.setItem("theme", mode); } catch { /* ignore */ } }
    paint();
  });
  paint();
}

function setup() {
  setupTheme();
  const ranges = $("ranges");
  for (const r of RANGES) {
    const b = el("button", null, r.label);
    b.type = "button";
    b.dataset.range = r.key;
    b.setAttribute("aria-pressed", String(r.key === S.range));
    if (r.days) b.title = r.days === Infinity ? "Everything saved" : "Last " + r.name;
    b.addEventListener("click", () => {
      if (D.caps.length < 2) return;
      for (const other of ranges.querySelectorAll("button")) other.setAttribute("aria-pressed", String(other === b));
      setRange(r.key);
      if (r.key === "custom") fillCustomSelects();
      render();
    });
    ranges.append(b);
  }
  for (const b of document.querySelectorAll("#modes button")) {
    b.addEventListener("click", () => {
      S.mode = b.dataset.mode;
      for (const other of document.querySelectorAll("#modes button")) other.setAttribute("aria-pressed", String(other === b));
      placeInk($("modes"));
      renderMain(true);
      writeHash();
    });
  }
  $("from-select").addEventListener("change", e => { S.from = Number(e.target.value); setRange("custom"); fillCustomSelects(); render(); });
  $("to-select").addEventListener("change", e => { S.to = Number(e.target.value); setRange("custom"); fillCustomSelects(); render(); });
  $("focus-chip").addEventListener("click", () => selectPaper(null));
  $("search").addEventListener("input", e => { S.search = e.target.value; renderTable(paperRows()); });
  $("changed-only").addEventListener("change", e => { S.changedOnly = e.target.checked; renderTable(paperRows()); });
  for (const b of document.querySelectorAll("th button")) {
    b.addEventListener("click", () => { S.sort = b.dataset.sort; renderTable(paperRows()); });
  }
  addEventListener("keydown", e => { if (e.key === "Escape" && S.paper) selectPaper(null); });

  let width = $("board").clientWidth, timer;
  new ResizeObserver(() => {
    const now = $("board").clientWidth;
    if (now === width) return;
    width = now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      render({ animate: false });
      for (const tabs of document.querySelectorAll(".tabs")) placeInk(tabs, true);
    }, 120);
  }).observe($("board"));
}

async function start() {
  await load();
  if (D.sample) { $("sample-band").hidden = false; $("scholar-link").hidden = true; }
  readHash();
  setRange(S.range);
  for (const b of document.querySelectorAll("#ranges button")) b.setAttribute("aria-pressed", String(b.dataset.range === S.range));
  for (const b of document.querySelectorAll("#modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
  $("checked").textContent = "Last checked " + F.full.format(D.caps.at(-1).time) + " PT";
  $("range-row").hidden = false;
  $("board").hidden = false;
  render();
}

setup();
start().catch(error => {
  const box = $("error");
  box.hidden = false;
  box.textContent = (error && error.message ? error.message + " " : "")
    + "Open this page through a local web server (see the README), not as a file.";
});
