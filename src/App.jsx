import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Papa from "papaparse";
import {
  ComposedChart, LineChart, BarChart, Line, Area, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from "recharts";

/* ==================================================================
   Ratings Lab - analysis for Ratings Central CSV exports.

   Everything runs in the browser. Files are read with FileReader and
   held in React state only: nothing is uploaded, nothing is written to
   disk, nothing is stored between sessions. Closing the tab discards it.
   ================================================================== */

/* ---------- shared helpers ---------- */

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const num = (v) => {
  if (v === null || v === undefined) return null;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

const parseDate = (v) => {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

const fmtDate = (t) =>
  new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtShort = (t) =>
  new Date(t).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
const signed = (n, d = 0) => (n >= 0 ? "+" : "") + n.toFixed(d);
const DAY = 864e5;

/* normal CDF, for comparing two Bayesian posteriors */
const erf = (x) => {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
};
const pStronger = (mA, sA, mB, sB) =>
  0.5 * (1 + erf((mA - mB) / Math.sqrt(2 * (sA * sA + sB * sB))));
const pWin = (diff, scale) => 1 / (1 + Math.pow(10, -diff / scale));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/* strip round and division numbers so a weekly pennant collapses to one series */
const seriesName = (name) =>
  String(name || "")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/\b(rnd|round|rd|div|division|wk|week|grade|section)\.?\s*\d+\w*\b/gi, " ")
    .replace(/\b\d+\s*-\s*\d+\b/g, " ")
    .replace(/[,\-]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim() || "Other";

/* ---------- CSV shapes ---------- */

const HISTORY_COLS = ["EventDate", "InitialMean", "FinalMean", "FinalStDev"];

const HINTS = {
  date: ["matchdate", "eventdate", "date", "played"],
  event: ["eventname", "event", "tournament", "competition"],
  opponent: ["opponentname", "opponent", "against", "versus"],
  opponentId: ["opponentid", "oppid"],
  opponentRating: ["opponentmean", "opponentrating", "opponentinitialmean", "opprating", "oppmean"],
  opponentSd: ["opponentstdev", "opponentsd", "oppstdev", "opponentstandarddeviation"],
  playerRating: ["playermean", "playerrating", "initialmean", "yourrating", "myrating", "mean", "rating"],
  playerSd: ["playerstdev", "playersd", "initialstdev", "stdev"],
  result: ["result", "wonlost", "winloss", "won", "outcome"],
  pointChange: ["pointchange", "pointsgained", "pointswon", "ratingchange", "ptchange", "points", "change"],
  score: ["score", "gamescores", "games", "points"],
};

const DIR_HINTS = {
  playerId: ["playerid", "id"],
  name: ["playername", "name", "player"],
  rating: ["mean", "rating"],
  sd: ["stdev", "standarddeviation", "sd"],
  club: ["club", "clubname"],
  country: ["country", "nation"],
  region: ["state", "province", "region", "federation"],
  lastPlayed: ["lastplayed", "lastevent", "lastdate"],
};

const rcLink = (id) => `https://www.ratingscentral.com/Player.php?PlayerID=${id}`;

function resolveColumns(headers) {
  const claimed = new Set();
  const out = {};
  const order = ["opponentRating", "opponentSd", "opponentId", "opponent",
    "pointChange", "playerRating", "playerSd", "event", "date", "result", "score"];
  for (const field of order) {
    let best = null, bestScore = 0;
    for (const h of headers) {
      if (claimed.has(h)) continue;
      const n = norm(h);
      for (const hint of HINTS[field]) {
        let s = 0;
        if (n === hint) s = 100 + hint.length;
        else if (n.startsWith(hint)) s = 60 + hint.length;
        else if (n.includes(hint)) s = 30 + hint.length;
        if (s > bestScore) { bestScore = s; best = h; }
      }
    }
    if (best) { out[field] = best; claimed.add(best); }
  }
  return out;
}

const parseWon = (v) => {
  const n = norm(v);
  if (["w", "win", "won", "1", "true", "victory"].includes(n)) return true;
  if (["l", "loss", "lost", "0", "false", "defeat"].includes(n)) return false;
  return null;
};

function parseHistoryRows(rows) {
  return rows
    .map((r) => ({
      eventId: num(r.EventID),
      event: String(r.EventName || "").trim(),
      t: parseDate(r.EventDate),
      initialMean: num(r.InitialMean),
      initialSd: num(r.InitialStDev),
      mean: num(r.FinalMean),
      sd: num(r.FinalStDev),
      change: num(r.PointChange),
    }))
    .filter((e) => e.t && e.mean != null)
    .sort((a, b) => a.t - b.t);
}

function parseMatchRows(rows, map) {
  return rows
    .map((r) => ({
      t: parseDate(r[map.date]),
      event: map.event ? String(r[map.event] || "").trim() : "",
      opponent: map.opponent ? String(r[map.opponent] || "").trim() : "",
      opponentId: map.opponentId ? num(r[map.opponentId]) : null,
      opponentRating: map.opponentRating ? num(r[map.opponentRating]) : null,
      opponentSd: map.opponentSd ? num(r[map.opponentSd]) : null,
      playerRating: map.playerRating ? num(r[map.playerRating]) : null,
      playerSd: map.playerSd ? num(r[map.playerSd]) : null,
      won: parseWon(r[map.result]),
      pointChange: map.pointChange ? num(r[map.pointChange]) : null,
      score: map.score ? String(r[map.score] || "").trim() : "",
    }))
    .filter((m) => m.t && m.opponent && m.won !== null)
    .sort((a, b) => a.t - b.t);
}

/* ---------- sample data: a real 61-event history ---------- */

const RAW = [
[54161,"TTACT 2025 Summer Pennant Thursday Rnd 1",250206,800,150,669,98],
[54598,"TTACT 2025 Summer Pennant Thursday Rnd 5",250306,670,100,576,67],
[54734,"TTACT 2025 Summer Pennant Thursday Rnd 6",250313,576,68,601,55],
[54848,"TTACT 2025 Summer Pennant Thursday Rnd 7",250320,601,56,618,50],
[54966,"TTACT 2025 Summer Pennant Thursday Rnd 8",250327,618,52,614,46],
[55075,"TTACT 2025 Summer Pennant Thursday Rnd 9",250403,615,48,618,44],
[55153,"TTACT 2025 P2 Autumn Semi Final",250408,618,45,634,43],
[55198,"TTACT 2025 P1 Summer Grand final",250410,634,44,643,42],
[55409,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 1",250501,643,46,667,46],
[55519,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 2",250508,667,47,662,42],
[55595,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 3",250515,662,43,667,40],
[55699,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 4",250522,667,41,649,36],
[55790,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 5",250529,649,38,662,37],
[55891,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 6",250605,662,39,650,35],
[55971,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 7",250612,650,37,665,36],
[56084,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 8",250619,665,38,679,38],
[56201,"TTACT 2025 P2 Autumn Pennant Thursdays Rnd 9",250626,679,39,684,39],
[56273,"TTACT 2025 P2 Autumn Pennant Semi Final",250701,684,40,696,42],
[56300,"TTACT 2025 P3 Autumn Pennant Grand Final",250703,696,43,694,36],
[56495,"TTACT 2025 P3 Tuesday night Pennant Rnd 1",250722,695,40,689,34],
[56582,"TTACT 2025 P3 Tuesday night Pennant Rnd 2",250729,689,36,705,34],
[56678,"TTACT 2025 P3 Tuesday night Pennant Rnd 3",250805,705,36,704,33],
[56768,"TTACT 2025 P3 Tuesday night Pennant Rnd 4",250812,704,35,717,34],
[56854,"TTACT 2025 P3 Tuesday night Pennant Rnd 5",250819,717,36,699,32],
[56924,"TTACT 2025 P3 Tuesday night Pennant Rnd 6",250826,699,34,713,32],
[56966,"2025 ACT Open Championships",250830,713,33,721,30],
[57004,"TTACT 2025 P3 Tuesday night Pennant Rnd 7",250902,721,31,730,29],
[57098,"TTACT 2025 P3 Tuesday night Pennant Rnd 8",250909,730,31,728,29],
[57291,"TTACT 2025 P3 Winter Pennant Semi Final 1",250923,729,33,720,31],
[57317,"TTACT 2025 P3 Winter Pennant Grand Final",250925,720,32,732,31],
[58348,"2025 NSW Open Championships",251130,733,46,754,38],
[58458,"Nam Ho's Heroes",251207,754,40,767,39],
[58856,"Macquarie University Open 2025",260131,768,50,753,42],
[58942,"2026 NSW Closed Championships",260207,753,44,751,37],
[59161,"SNDTTA Autumn 2026-02-22",260222,752,41,763,40],
[59487,"SNDTTA AUTUMN Rnd2 2026-02-27",260227,763,41,786,43],
[59505,"2026 St George and Sutherland Shire Open Championships",260307,787,44,827,43],
[59631,"SNDTTA Autumn 2026-03-13",260313,827,44,859,55],
[59873,"SNDTTA Autumn Rnd 6 2026-03-27",260327,859,58,840,38],
[59978,"SNDTTA Autumn Rnd 7 2026-04-04",260404,840,40,854,42],
[60051,"SNDTTA Autumn Rnd8 2026-04-10",260410,854,43,876,48],
[60245,"SNDTTA Autumn Round 10",260424,876,50,885,51],
[60259,"2026 Sophia Wellness x RTTC Open Championships",260425,885,52,866,42],
[60688,"SNDTTA Autumn Div4 Knockout 1-22 May",260430,867,43,915,49],
[60348,"SNDTTA Autumn Round11",260501,915,50,916,50],
[60370,"Nittaku NHTTA Championships May 2026",260502,916,50,885,40],
[60451,"SNDTTA Autumn Round 12",260508,886,41,880,39],
[60561,"SNDTTA Autumn Round 13",260515,880,40,857,36],
[60660,"SNDTTA Autumn Round 14",260522,857,37,865,37],
[60757,"SNDTTA Autumn Round 15",260529,865,39,867,38],
[60904,"SNDTTA Autumn Round 16",260605,867,40,848,37],
[60859,"Norwest Open 2026 - Series 1",260606,848,37,842,35],
[60972,"SNDTTA Autumn Round 17",260612,843,36,858,37],
[61393,"SNDTTA Autumn Round 18 2026-06-19",260619,858,38,853,35],
[61503,"SNDTTA Spring Round 1",260713,853,41,866,40],
[61590,"SNDTTA Spring Round 2",260720,866,42,855,38],
[61695,"SNDTTA Spring Round 3",260727,855,39,856,39],
[61829,"SNDTTA Spring Round 4",260803,857,41,883,40],
[61809,"Annual SNDTTA Closed 2026",260807,883,41,889,36],
[61976,"SNDTTA Spring Round 6",260817,889,38,891,37],
[62065,"2026 ACT Open Championships",260829,891,39,895,37]
];

const SAMPLE = RAW.map(([id, name, ymd, im, isd, fm, fsd]) => ({
  eventId: id, event: name,
  t: new Date(2000 + Math.floor(ymd / 10000), (Math.floor(ymd / 100) % 100) - 1, ymd % 100).getTime(),
  initialMean: im, initialSd: isd, mean: fm, sd: fsd, change: fm - im,
}));

/* ---------- analysis ---------- */

function analyseHistory(events) {
  if (!events.length) return null;
  const first = events[0], last = events[events.length - 1];
  const changes = events.map((e) => e.change);
  const means = events.map((e) => e.mean);
  const peak = Math.max(...means), trough = Math.min(...means);
  const peakAt = events[means.indexOf(peak)];

  let bestRun = 0, run = 0, bestRunPts = 0, runPts = 0;
  for (const e of events) {
    if (e.change > 0) { run++; runPts += e.change; }
    else { run = 0; runPts = 0; }
    if (run > bestRun) { bestRun = run; bestRunPts = runPts; }
  }
  let streak = 0, streakUp = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const up = events[i].change > 0;
    if (streakUp === null) streakUp = up;
    else if (up !== streakUp) break;
    streak++;
  }

  const gaps = [];
  for (let i = 1; i < events.length; i++) gaps.push((events[i].t - events[i - 1].t) / DAY);
  const longestGap = gaps.length ? Math.max(...gaps) : 0;

  const window = (days) => {
    const from = last.t - days * DAY;
    const w = events.filter((e) => e.t >= from);
    if (!w.length) return null;
    return { n: w.length, net: w[w.length - 1].mean - w[0].initialMean };
  };

  const bySeries = {};
  for (const e of events) {
    const k = seriesName(e.event);
    bySeries[k] = bySeries[k] || { n: 0, net: 0, up: 0, name: k };
    bySeries[k].n++;
    bySeries[k].net += e.change;
    if (e.change > 0) bySeries[k].up++;
  }

  const sorted = [...events].sort((a, b) => a.change - b.change);

  return {
    first, last, peak, peakAt, trough,
    net: last.mean - first.initialMean,
    up: changes.filter((c) => c > 0).length,
    down: changes.filter((c) => c < 0).length,
    avgMove: mean(changes.map(Math.abs)),
    volatility: sd(changes),
    bestRun, bestRunPts, streak, streakUp,
    best: sorted[sorted.length - 1], worst: sorted[0],
    longestGap,
    perMonth: events.length / Math.max(1, (last.t - first.t) / DAY / 30.4),
    d90: window(90), d180: window(180), d365: window(365),
    series: Object.values(bySeries).sort((a, b) => b.n - a.n),
    fromPeak: last.mean - peak,
  };
}

function rollingForm(events, k = 5) {
  return events.map((e, i) => {
    const slice = events.slice(Math.max(0, i - k + 1), i + 1);
    return { ...e, form: slice.reduce((s, x) => s + x.change, 0), band: [e.mean - e.sd, e.mean + e.sd] };
  });
}

function analyseH2H(meetings, scale) {
  const wins = meetings.filter((m) => m.won).length;
  const losses = meetings.length - wins;
  let streak = 0, streakWon = null;
  for (let i = meetings.length - 1; i >= 0; i--) {
    if (streakWon === null) streakWon = meetings[i].won;
    else if (meetings[i].won !== streakWon) break;
    streak++;
  }
  const rated = meetings.filter((m) => m.playerRating != null && m.opponentRating != null);
  const expected = rated.reduce((s, m) => s + pWin(m.playerRating - m.opponentRating, scale), 0);
  const actualRated = rated.filter((m) => m.won).length;
  const upsets = rated.filter((m) => m.won && m.playerRating < m.opponentRating).length;
  const blown = rated.filter((m) => !m.won && m.playerRating > m.opponentRating).length;
  const gapFirst = rated.length ? rated[0].playerRating - rated[0].opponentRating : null;
  const gapLast = rated.length ? rated[rated.length - 1].playerRating - rated[rated.length - 1].opponentRating : null;

  const last = rated[rated.length - 1];
  let confidence = null;
  if (last && last.playerSd != null && last.opponentSd != null) {
    confidence = pStronger(last.playerRating, last.playerSd, last.opponentRating, last.opponentSd);
  }

  const pointed = meetings.filter((m) => m.pointChange != null);
  const netPoints = pointed.reduce((s, m) => s + m.pointChange, 0);

  const byEvent = {};
  for (const m of meetings) {
    const k = m.event || "Unlabelled";
    byEvent[k] = byEvent[k] || { w: 0, l: 0, name: k };
    byEvent[k][m.won ? "w" : "l"]++;
  }

  const byYear = {};
  for (const m of meetings) {
    const y = new Date(m.t).getFullYear();
    byYear[y] = byYear[y] || { year: y, w: 0, l: 0 };
    byYear[y][m.won ? "w" : "l"]++;
  }

  return {
    wins, losses, streak, streakWon, expected, actualRated, ratedCount: rated.length,
    netPoints, pointedCount: pointed.length,
    upsets, blown, gapFirst, gapLast, confidence, rated,
    byEvent: Object.values(byEvent).sort((a, b) => b.w + b.l - (a.w + a.l)),
    byYear: Object.values(byYear).sort((a, b) => a.year - b.year),
    nextWin: last ? pWin(last.playerRating - last.opponentRating, scale) : null,
  };
}

/* ---------- styles ---------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

.rl {
  --ink:#0F1B23; --court:#17547E; --court-lo:#3D7FA8; --ball:#E8590C;
  --floor:#E7EBEE; --line:#D3DBE1; --muted:#64798A; --pale:#F3F6F8;
  background:var(--floor); color:var(--ink);
  font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
  font-size:15px; line-height:1.55; min-height:100%;
  padding:0 0 60px; -webkit-text-size-adjust:100%;
}
.rl *{box-sizing:border-box}
.rl h1,.rl h2,.rl h3{font-family:'Barlow Condensed',system-ui,sans-serif;font-weight:600;margin:0;letter-spacing:.01em}
.rl h1{font-size:30px;line-height:1.05}
.rl h2{font-size:21px;margin-bottom:4px}
.rl h3{font-size:16px;color:var(--muted);font-weight:500}
.rl p{margin:0}
.wrap{max-width:1000px;margin:0 auto;padding:0 18px}

/* header + nav */
.top{background:var(--ink);color:#fff;padding:22px 0 0}
.top h1{color:#fff}
.top .sub{color:#93A6B3;font-size:14px;margin-top:5px;max-width:60ch}
.nav{display:flex;gap:4px;margin-top:18px}
.nav button{
  flex:1 1 0;font-family:'Barlow Condensed',sans-serif;font-size:17px;
  background:transparent;color:#93A6B3;border:0;border-bottom:3px solid transparent;
  padding:11px 8px;cursor:pointer;text-align:left;min-height:44px;
}
.nav button[aria-selected=true]{color:#fff;border-bottom-color:var(--ball)}
.nav .n{display:block;font-size:12px;font-family:'IBM Plex Sans',sans-serif;color:#63798A}

/* privacy strip */
.privacy{background:#12303F;color:#A9C3D2;font-size:12.5px;padding:9px 0}
.privacy .wrap{display:flex;gap:8px;align-items:flex-start}
.privacy svg{flex:none;margin-top:2px}

.body{padding-top:20px}
.panel{background:#fff;border:1px solid var(--line);border-radius:4px;padding:18px;margin-bottom:16px}
.panel > h2 + p.lede{color:var(--muted);font-size:13.5px;margin-bottom:14px;max-width:72ch}

/* instructions */
.howto{background:#fff;border:1px solid var(--line);border-radius:4px;overflow:hidden;margin-bottom:16px}
.howto summary{padding:14px 18px;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:19px;list-style:none;display:flex;justify-content:space-between;align-items:center;min-height:48px}
.howto summary::-webkit-details-marker{display:none}
.howto summary::after{content:'+';font-size:22px;color:var(--muted)}
.howto[open] summary::after{content:'\\2212'}
.howto .inner{padding:0 18px 18px;border-top:1px solid var(--line)}
.howto ol{margin:14px 0 0;padding-left:20px;color:var(--ink);font-size:14px}
.howto li{margin:9px 0}
.howto code{background:var(--pale);border:1px solid var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;word-break:break-all}
.howto .tipbox{margin-top:14px;padding:11px 13px;background:var(--pale);border-left:3px solid var(--court-lo);font-size:13.5px;color:var(--muted);border-radius:0 3px 3px 0}

/* instructions */
.guide{background:#fff;border:1px solid var(--line);border-left:3px solid var(--court);border-radius:4px;padding:18px;margin-bottom:16px}
.guide h2{margin-bottom:4px}
.guide .lede{color:var(--muted);font-size:13.5px;margin-bottom:14px;max-width:72ch}
.guide .steps{margin:0;padding-left:20px;font-size:14.5px}
.guide .steps li{margin:10px 0;padding-left:2px}
.guide .hint{color:var(--muted);font-size:13px;margin-top:12px;max-width:74ch}
.guide code{background:var(--pale);border:1px solid var(--line);padding:1px 5px;border-radius:3px;font-size:12.5px;word-break:break-all}
.idbox{background:var(--pale);border-radius:3px;padding:13px 14px;margin-bottom:16px}
.idbox .field{max-width:320px}
.idbox .hint{margin-top:9px}
.lnk{color:var(--court);text-decoration:underline;text-underline-offset:2px}
.lnk:hover{color:var(--ball)}

/* drop zone */
.drop{border:1.5px dashed #A9B7C1;border-radius:4px;padding:26px 18px;text-align:center;background:#fff;margin-bottom:16px}
.drop.over{border-color:var(--court);background:#EFF6FA}
.drop p{color:var(--muted);font-size:14px;margin-top:6px}
.drop.compact{padding:14px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;text-align:left}
.drop.compact h2{font-size:17px;margin:0}
.drop.compact p{margin:0;font-size:13px}
.drop .or{color:var(--muted);font-size:13px;margin:12px 0 10px}

/* controls */
.rl button.btn{font-family:inherit;font-size:15px;border:1px solid var(--court);background:var(--court);color:#fff;padding:11px 18px;border-radius:3px;cursor:pointer;min-height:44px}
.rl button.btn.ghost{background:#fff;color:var(--court)}
.rl button.btn.sm{font-size:13.5px;padding:8px 12px;min-height:38px}
.rl button.chip{font-family:inherit;font-size:13px;border:1px solid var(--line);background:#fff;color:var(--muted);padding:7px 11px;border-radius:99px;cursor:pointer;min-height:36px}
.rl button.chip[aria-pressed=true]{background:var(--court);border-color:var(--court);color:#fff}
.rl input,.rl select{font-family:inherit;font-size:16px;color:var(--ink);border:1px solid #B9C5CD;border-radius:3px;padding:10px 11px;background:#fff;width:100%;min-height:44px}
.rl :focus-visible{outline:2px solid var(--ball);outline-offset:2px}
.field{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--muted);min-width:0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}

/* scoreboard */
.board{background:var(--court);border-radius:4px;padding:22px 20px;position:relative;margin-bottom:16px;overflow:hidden}
.board::after{content:'';position:absolute;inset:9px;border:1px solid rgba(255,255,255,.2);border-radius:3px;pointer-events:none}
.board .who{font-family:'Barlow Condensed',sans-serif;font-size:23px;color:#fff;line-height:1.15}
.board .tag{font-size:12.5px;color:rgba(255,255,255,.6);margin-top:2px}
.bigrow{display:flex;align-items:baseline;gap:12px;margin-top:6px;flex-wrap:wrap}
.big{font-family:'Barlow Condensed',sans-serif;font-size:84px;line-height:.9;color:#fff}
.pm{font-family:'Barlow Condensed',sans-serif;font-size:26px;color:rgba(255,255,255,.68)}
.bfoot{display:flex;gap:18px;flex-wrap:wrap;margin-top:14px;font-size:12.5px;color:rgba(255,255,255,.72)}

.vs{display:grid;grid-template-columns:1fr 2px 1fr;align-items:center}
.vs .centre{background:rgba(255,255,255,.5);align-self:stretch}
.vs .side{padding:0 14px;min-width:0}
.vs .side.r{text-align:right}
.vs .tally{font-family:'Barlow Condensed',sans-serif;font-size:76px;line-height:.9;color:#fff;margin-top:4px}
.vs .side.r .tally{color:#FFB27A}
.vs .nm{font-family:'Barlow Condensed',sans-serif;font-size:19px;color:#fff;overflow-wrap:anywhere}
.share{display:flex;height:5px;margin:16px 6px 0;border-radius:3px;overflow:hidden;background:rgba(255,255,255,.2)}
.share i{display:block}

/* stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:4px;margin-bottom:16px}
.stat{background:#fff;padding:13px 15px;min-width:0}
.stat .v{font-family:'Barlow Condensed',sans-serif;font-size:29px;line-height:1.05;overflow-wrap:anywhere}
.stat .k{font-size:12.5px;color:var(--muted);margin-top:1px;line-height:1.35}
.pos{color:var(--court)} .neg{color:var(--ball)}

/* tables */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -18px;padding:0 18px}
.scroll.tall{max-height:400px;overflow-y:auto}
.tbl{width:100%;border-collapse:collapse;font-size:14px;min-width:480px}
.tbl th{text-align:left;font-weight:500;color:var(--muted);border-bottom:1px solid var(--line);padding:9px 10px;white-space:nowrap;font-size:12.5px;position:sticky;top:0;background:#fff}
.tbl td{padding:9px 10px;border-bottom:1px solid #EEF2F5;white-space:nowrap}
.tbl tr:last-child td{border-bottom:0}
.tbl .n{text-align:right;font-variant-numeric:tabular-nums}
.tbl .wide{white-space:normal;min-width:190px}
.pill{display:inline-block;min-width:24px;text-align:center;border-radius:3px;padding:2px 7px;font-size:12.5px;color:#fff;font-weight:500}
.pill.w{background:var(--court)} .pill.l{background:var(--ball)}
.flag{color:var(--ball);font-size:12px}

.note{color:var(--muted);font-size:13px;margin-top:11px;max-width:74ch}
.err{border-color:var(--ball);background:#FEF3EC}
.tip{background:#fff;border:1px solid #B9C5CD;border-radius:3px;padding:8px 10px;font-size:13px;box-shadow:0 2px 6px rgba(15,27,35,.09)}
.tip b{font-weight:600}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-top:9px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.empty{color:var(--muted);text-align:center;padding:26px 12px}

@media (max-width:640px){
  .rl h1{font-size:25px}
  .big{font-size:62px}
  .vs .tally{font-size:50px}
  .vs .nm{font-size:16px}
  .vs .side{padding:0 9px}
  .stat .v{font-size:25px}
  .wrap{padding:0 14px}
  .scroll{margin:0 -14px;padding:0 14px}
  .panel{padding:15px}
}
@media (prefers-reduced-motion:reduce){.rl *{animation:none!important;transition:none!important}}
`;

/* ---------- small components ---------- */

const useNarrow = () => {
  const [n, setN] = useState(typeof window !== "undefined" && window.innerWidth < 640);
  useEffect(() => {
    const f = () => setN(window.innerWidth < 640);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return n;
};

const Stat = ({ v, k, tone }) => (
  <div className="stat">
    <div className={"v " + (tone || "")}>{v}</div>
    <div className="k">{k}</div>
  </div>
);

function DropZone({ onFile, title, hint, over, setOver, compact }) {
  const ref = useRef(null);
  if (compact) {
    return (
      <div className={"drop compact" + (over ? " over" : "")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files?.[0]); }}
      >
        <div>
          <h2>{title}</h2>
          <p>{hint}</p>
        </div>
        <button className="btn sm" onClick={() => ref.current?.click()}>Choose a file</button>
        <input ref={ref} type="file" accept=".csv,text/csv,text/plain" style={{ display: "none" }}
               onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    );
  }
  return (
    <div
      className={"drop" + (over ? " over" : "")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files?.[0]); }}
    >
      <h2>{title}</h2>
      <p>{hint}</p>
      <p className="or">Drag a file here, or</p>
      <button className="btn" onClick={() => ref.current?.click()}>Choose a CSV file</button>
      <input ref={ref} type="file" accept=".csv,text/csv,text/plain" style={{ display: "none" }}
             onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}

const HistoryTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="tip">
      <b>{d.event}</b>
      <div>{fmtDate(d.t)}</div>
      <div>{d.mean} &plusmn; {d.sd} ({signed(d.change)})</div>
    </div>
  );
};

const GapTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="tip">
      <b>{d.won ? "Won" : "Lost"}</b>{d.score ? ` ${d.score}` : ""}
      <div>{fmtDate(d.t)}</div>
      <div>{d.event}</div>
      <div>{d.playerRating} v {d.opponentRating} ({signed(d.gap)})</div>
    </div>
  );
};

/* ---------- instructions ---------- */

function Instructions({ mode, pid, setPid }) {
  const id = String(pid || "").replace(/[^0-9]/g, "");
  const RC = "https://www.ratingscentral.com";
  const A = ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="lnk">{children}</a>
  );

  return (
    <section className="guide">
      <h2>{mode === "history" ? "How to analyse a player" : "How to compare two players"}</h2>
      <p className="lede">
        {mode === "history"
          ? "You need one file: that player's rating history, exported from Ratings Central."
          : "You need one file: the player's full match list, exported from Ratings Central. It holds every opponent, so one file covers every rivalry."}
      </p>

      <div className="idbox">
        <label className="field">
          Player ID, optional. Fill it in and the links below go straight to the right page.
          <input type="text" inputMode="numeric" placeholder="e.g. 158717" value={pid}
                 onChange={(e) => setPid(e.target.value)} />
        </label>
        <p className="hint">
          Do not know it? <A href={RC + "/PlayerSearch.php"}>Search for the player</A>, open their
          page, and the number at the end of the address is the ID.
        </p>
      </div>

      <ol className="steps">
        <li>
          Open the player&rsquo;s page on Ratings Central:{" "}
          {id
            ? <A href={RC + "/Player.php?PlayerID=" + id}>Player {id}</A>
            : <A href={RC + "/PlayerSearch.php"}>find them here first</A>}
        </li>
        {mode === "history" ? (
          <li>Click <b>Rating-History Graph</b> in the row of links near the top of their page.</li>
        ) : (
          <li>
            Go to <b>Match Search</b>
            {id ? <> &mdash; <A href={RC + "/MatchSearch.php?PlayerID=" + id}>open it for player {id}</A></> : null}
            . Leave the opponent <b>Name</b> field blank so you get every opponent, and leave the
            rating and date fields blank too.
          </li>
        )}
        <li>
          Find the <b>Output</b> control and set it to one of the <b>CSV</b> options. One downloads a
          file, the other shows the text in the browser.
        </li>
        <li>
          Save the file{mode === "history" ? <>, named something like <code>PlayerHistory_158717.csv</code></> : null}, then drop it below.
        </li>
      </ol>

      <p className="hint">
        {mode === "history"
          ? "Each row is one event: the rating carried in, the points gained or lost, the rating carried out. Every rating comes with a standard deviation, which is how certain the system is about that player. This app keeps it."
          : "Ratings Central returns CSV rows unsorted. That is fine, this app sorts by date. If your file uses column names it does not recognise, a mapping panel appears so you can point it at the right ones."}
      </p>
    </section>
  );
}

/* ---------- privacy strip ---------- */

const Privacy = () => (
  <div className="privacy">
    <div className="wrap">
      <svg width="13" height="15" viewBox="0 0 13 15" fill="none" aria-hidden="true">
        <path d="M6.5 1 1 3.2v4c0 3.2 2.3 6 5.5 6.8C9.7 13.2 12 10.4 12 7.2v-4L6.5 1Z"
              stroke="#A9C3D2" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      <span>
        Your file is read in your browser and never sent anywhere. There is no server, no account,
        no cookie and no stored copy. Reloading this page erases everything.
      </span>
    </div>
  </div>
);

/* ================= MODE 1: player history ================= */

function HistoryMode({ events, label, onFile, over, setOver, onClear, isSample, pid, setPid }) {
  const [hideProv, setHideProv] = useState(true);
  const [span, setSpan] = useState("all");
  const narrow = useNarrow();

  const scoped = useMemo(() => {
    let e = hideProv ? events.filter((x) => x.initialSd <= 60) : events;
    if (span !== "all" && e.length) {
      const from = e[e.length - 1].t - Number(span) * DAY;
      const w = e.filter((x) => x.t >= from);
      if (w.length > 1) e = w;
    }
    return e;
  }, [events, hideProv, span]);

  const a = useMemo(() => analyseHistory(scoped), [scoped]);
  const chart = useMemo(() => rollingForm(scoped), [scoped]);
  const provEnd = useMemo(() => {
    const p = events.filter((x) => x.initialSd > 60);
    return p.length ? p[p.length - 1].t : null;
  }, [events]);

  const head = (
    <>
      <Instructions mode="history" pid={pid} setPid={setPid} />
      <DropZone onFile={onFile} over={over} setOver={setOver} compact={!isSample}
                title={isSample ? "Load a rating history" : "Load a different rating history"}
                hint="The PlayerHistory CSV, one row per event." />
    </>
  );
  if (!a) return <>{head}<div className="panel empty">Not enough events in range.</div></>;

  const H = narrow ? 220 : 300;

  return (
    <>
      {head}

      <div className="board">
        <div className="who">{label}</div>
        <div className="tag">
          {events.length} events, {fmtDate(events[0].t)} to {fmtDate(events[events.length - 1].t)}
        </div>
        <div className="bigrow">
          <span className="big">{Math.round(a.last.mean)}</span>
          <span className="pm">&plusmn; {Math.round(a.last.sd)}</span>
        </div>
        <div className="bfoot">
          <span>Peak {Math.round(a.peak)}, {fmtDate(a.peakAt.t)}</span>
          <span>{a.fromPeak === 0 ? "At peak now" : `${Math.round(a.fromPeak)} from peak`}</span>
          <span>True strength likely {Math.round(a.last.mean - a.last.sd)}&ndash;{Math.round(a.last.mean + a.last.sd)}</span>
        </div>
      </div>

      <div className="panel">
        <div className="grid2">
          <label className="field">
            Period
            <select value={span} onChange={(e) => setSpan(e.target.value)}>
              <option value="all">All time</option>
              <option value="90">Last 90 days</option>
              <option value="180">Last 6 months</option>
              <option value="365">Last 12 months</option>
            </select>
          </label>
          <label className="field">
            Provisional events
            <select value={hideProv ? "hide" : "show"} onChange={(e) => setHideProv(e.target.value === "hide")}>
              <option value="hide">Hide the settling-in period</option>
              <option value="show">Show every event</option>
            </select>
          </label>
        </div>
        <p className="note">
          A new player starts on a default rating with a very wide standard deviation, and the first
          few results are the system working out where you belong rather than a change in your form.
          Hiding events that began with a deviation above 60 removes that noise.
        </p>
        <div className="chips">
          {!isSample && <button className="chip" onClick={onClear}>Clear this file</button>}
        </div>
      </div>

      <div className="stats">
        <Stat v={signed(a.net)} k="Net points across the period" tone={a.net >= 0 ? "pos" : "neg"} />
        <Stat v={`${a.up} / ${a.down}`} k="Events gained / lost points" />
        <Stat v={Math.round(a.avgMove)} k="Average points moved per event" />
        <Stat v={`\u00B1${Math.round(a.last.sd)}`} k={`Uncertainty now, from \u00B1${Math.round(events[0].initialSd)} at the start`} />
        <Stat v={a.bestRun} k={`Longest rising run, worth ${signed(a.bestRunPts)}`} />
        <Stat v={Math.round(a.volatility)} k="Swing size, one deviation of your point changes" />
        <Stat v={a.perMonth.toFixed(1)} k="Events per month" />
        <Stat v={Math.round(a.longestGap)} k="Longest gap between events, in days" />
      </div>

      <div className="panel">
        <h2>Rating with confidence band</h2>
        <p className="lede">
          The line steps because your rating only moves when an event is processed. The band is one
          standard deviation either side.
        </p>
        <ResponsiveContainer width="100%" height={H}>
          <ComposedChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#EEF2F5" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                   tickFormatter={fmtShort} stroke="#64798A" fontSize={11} minTickGap={26} />
            <YAxis stroke="#64798A" fontSize={11} domain={["dataMin - 25", "dataMax + 25"]} width={46} />
            <Tooltip content={<HistoryTip />} />
            {provEnd && !hideProv && (
              <ReferenceArea x1={chart[0].t} x2={provEnd} fill="#E8590C" fillOpacity={0.06} />
            )}
            <Area dataKey="band" stroke="none" fill="#17547E" fillOpacity={0.14} isAnimationActive={false} />
            <Line dataKey="mean" type="stepAfter" stroke="#17547E" strokeWidth={2}
                  dot={{ r: 2 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="legend">
          <span><i style={{ background: "#17547E" }} />Rating</span>
          <span><i style={{ background: "#17547E", opacity: .25 }} />One standard deviation</span>
          {provEnd && !hideProv && <span><i style={{ background: "#E8590C", opacity: .25 }} />Provisional period</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Points won and lost per event</h2>
        <p className="lede">Blue bars are events you left with more than you brought.</p>
        <ResponsiveContainer width="100%" height={narrow ? 170 : 210}>
          <BarChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#EEF2F5" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                   tickFormatter={fmtShort} stroke="#64798A" fontSize={11} minTickGap={26} />
            <YAxis stroke="#64798A" fontSize={11} width={46} />
            <ReferenceLine y={0} stroke="#64798A" />
            <Tooltip content={<HistoryTip />} />
            <Bar dataKey="change" isAnimationActive={false}>
              {chart.map((d, i) => <Cell key={i} fill={d.change >= 0 ? "#17547E" : "#E8590C"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="note">
          Best single event: {a.best.event} on {fmtDate(a.best.t)}, {signed(a.best.change)}.
          Worst: {a.worst.event} on {fmtDate(a.worst.t)}, {signed(a.worst.change)}.
        </p>
      </div>

      <div className="panel">
        <h2>Form, five events at a time</h2>
        <p className="lede">
          Points gained across each rolling window of five events. Above the line you are trending up
          regardless of what any single result did.
        </p>
        <ResponsiveContainer width="100%" height={narrow ? 170 : 200}>
          <ComposedChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#EEF2F5" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                   tickFormatter={fmtShort} stroke="#64798A" fontSize={11} minTickGap={26} />
            <YAxis stroke="#64798A" fontSize={11} width={46} />
            <ReferenceLine y={0} stroke="#64798A" />
            <Tooltip content={<HistoryTip />} />
            <Area dataKey="form" stroke="#17547E" strokeWidth={2} fill="#17547E" fillOpacity={0.13}
                  isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="panel">
        <h2>Where your points come from</h2>
        <p className="lede">
          Competitions grouped by name, with round and division numbers stripped out.
        </p>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th className="wide">Competition</th><th className="n">Events</th><th className="n">Net</th><th className="n">Per event</th><th className="n">Up</th></tr></thead>
            <tbody>
              {a.series.map((s) => (
                <tr key={s.name}>
                  <td className="wide">{s.name}</td>
                  <td className="n">{s.n}</td>
                  <td className="n" style={{ color: s.net >= 0 ? "#17547E" : "#E8590C" }}>{signed(s.net)}</td>
                  <td className="n">{signed(s.net / s.n, 1)}</td>
                  <td className="n">{s.up}/{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Every event</h2>
        <div className="scroll tall">
          <table className="tbl">
            <thead><tr><th>Date</th><th className="wide">Event</th><th className="n">In</th><th className="n">Change</th><th className="n">Out</th><th className="n">SD</th></tr></thead>
            <tbody>
              {[...scoped].reverse().map((e) => (
                <tr key={e.eventId ?? e.t}>
                  <td>{fmtDate(e.t)}</td>
                  <td className="wide">{e.event}</td>
                  <td className="n">{Math.round(e.initialMean)}</td>
                  <td className="n" style={{ color: e.change >= 0 ? "#17547E" : "#E8590C" }}>{signed(e.change)}</td>
                  <td className="n">{Math.round(e.mean)}</td>
                  <td className="n">{Math.round(e.sd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ================= MODE 2: head to head ================= */

function H2HMode({ matches, history, colMap, headers, setColMap, onFile, over, setOver, onClear, pid, setPid }) {
  const [query, setQuery] = useState("");
  const [opponent, setOpponent] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [scale, setScale] = useState(200);
  const narrow = useNarrow();

  const opponents = useMemo(() => {
    const m = new Map();
    for (const x of matches) {
      const e = m.get(x.opponent) || { name: x.opponent, n: 0, w: 0, last: 0 };
      e.n++; if (x.won) e.w++; e.last = Math.max(e.last, x.t);
      m.set(x.opponent, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [matches]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? opponents.filter((o) => o.name.toLowerCase().includes(q)) : opponents;
  }, [opponents, query]);

  useEffect(() => {
    if (!opponent && opponents.length) setOpponent(opponents[0].name);
  }, [opponents, opponent]);
  useEffect(() => {
    if (query && filtered.length && !filtered.some((o) => o.name === opponent)) {
      setOpponent(filtered[0].name);
    }
  }, [query, filtered, opponent]);

  const events = useMemo(() => {
    const s = new Set(matches.filter((m) => m.opponent === opponent).map((m) => m.event).filter(Boolean));
    return [...s].sort();
  }, [matches, opponent]);

  const meetings = useMemo(
    () => matches.filter((m) => m.opponent === opponent && (eventFilter === "all" || m.event === eventFilter)),
    [matches, opponent, eventFilter]
  );

  const a = useMemo(() => analyseH2H(meetings, scale), [meetings, scale]);

  // If the match export has no per-match points, fall back to the event total
  // from a loaded rating-history file. Clearly marked as a different thing.
  const eventPoints = useMemo(() => {
    const m = new Map();
    for (const e of history || []) if (e.event) m.set(e.event.trim().toLowerCase(), e.change);
    return m;
  }, [history]);
  const opponentId = useMemo(() => {
    const withId = meetings.find((m) => m.opponentId);
    return withId ? withId.opponentId : null;
  }, [meetings]);
  const hasMatchPoints = meetings.some((m) => m.pointChange != null);
  const usesEventFallback = !hasMatchPoints && eventPoints.size > 0
    && meetings.some((m) => eventPoints.has((m.event || "").trim().toLowerCase()));
  const series = useMemo(
    () => a.rated.map((m) => ({ ...m, gap: m.playerRating - m.opponentRating })),
    [a.rated]
  );

  const head = (
    <>
      <Instructions mode="h2h" pid={pid} setPid={setPid} />
      <DropZone onFile={onFile} over={over} setOver={setOver} compact={matches.length > 0}
                title={matches.length ? "Load a different match file" : "Load a match history"}
                hint="The Match Search CSV, one row per match, opponent field left blank." />
    </>
  );
  if (!matches.length) return head;

  const total = a.wins + a.losses || 1;
  const H = narrow ? 200 : 250;
  const missingCols = !colMap?.playerRating || !colMap?.opponentRating;

  return (
    <>
      {head}

      <div className="panel">
        <h2>Choose an opponent</h2>
        <p className="lede">
          {matches.length} matches against {opponents.length} opponents in this file.
        </p>
        <div className="grid2">
          <label className="field">
            Search by name
            <input type="search" placeholder="Start typing a surname" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="field">
            Opponent{query ? ` (${filtered.length} matching)` : ""}
            <select value={opponent} onChange={(e) => { setOpponent(e.target.value); setEventFilter("all"); }}>
              {filtered.length === 0 && <option value="">No opponent matches that search</option>}
              {filtered.map((o) => (
                <option key={o.name} value={o.name}>{o.name} ({o.n})</option>
              ))}
            </select>
          </label>
          <label className="field">
            Event
            <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)}>
              <option value="all">All events</option>
              {events.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="field">
            Rating scale for win probability
            <input type="number" min="25" max="1200" step="25" value={scale}
                   onChange={(e) => setScale(Math.max(25, +e.target.value || 200))} />
          </label>
        </div>
        <div className="chips">
          <button className="chip" onClick={onClear}>Clear this file</button>
        </div>
      </div>

      {colMap && (
        <details className="howto">
          <summary>Column mapping</summary>
          <div className="inner">
            <p className="note" style={{ marginTop: 12 }}>
              Guessed from your file's headers. Change anything that looks wrong and every number
              below updates.
            </p>
            <div className="grid2" style={{ marginTop: 12 }}>
              {[["date", "Date"], ["opponent", "Opponent"], ["result", "Result"],
                ["playerRating", "Your rating"], ["playerSd", "Your deviation"],
                ["opponentRating", "Opponent rating"], ["opponentSd", "Opponent deviation"],
                ["pointChange", "Points gained or lost"],
                ["event", "Event"], ["score", "Score"]].map(([f, lbl]) => (
                <label className="field" key={f}>
                  {lbl}
                  <select value={colMap[f] || ""} onChange={(e) => setColMap({ ...colMap, [f]: e.target.value })}>
                    <option value="">not used</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
        </details>
      )}

      {meetings.length === 0 ? (
        <div className="panel empty">No matches against this opponent in the current filter.</div>
      ) : (
        <>
          <div className="board">
            <div className="vs">
              <div className="side">
                <div className="nm">You</div>
                <div className="tally">{a.wins}</div>
              </div>
              <div className="centre" />
              <div className="side r">
                <div className="nm">
                  {opponentId ? (
                    <a href={rcLink(opponentId)} target="_blank" rel="noopener noreferrer"
                       style={{ color: "#fff" }}>{opponent}</a>
                  ) : opponent}
                </div>
                <div className="tally">{a.losses}</div>
              </div>
            </div>
            <div className="share">
              <i style={{ width: `${(a.wins / total) * 100}%`, background: "#fff" }} />
              <i style={{ width: `${(a.losses / total) * 100}%`, background: "#E8590C" }} />
            </div>
            <div className="bfoot">
              <span>{Math.round((a.wins / total) * 100)}% win rate over {meetings.length} meetings</span>
              <span>{a.streak} straight {a.streakWon ? "wins" : "losses"} most recently</span>
              <span>First met {fmtDate(meetings[0].t)}</span>
            </div>
          </div>

          <div className="stats">
            <Stat v={a.ratedCount ? a.expected.toFixed(1) : "\u2014"} k="Wins the ratings predicted" />
            <Stat v={a.ratedCount ? signed(a.actualRated - a.expected, 1) : "\u2014"}
                  k="Actual wins above prediction"
                  tone={a.actualRated - a.expected >= 0 ? "pos" : "neg"} />
            <Stat v={a.upsets} k="Wins while the lower-rated player" />
            <Stat v={a.blown} k="Losses while the higher-rated player" />
            <Stat v={a.gapLast == null ? "\u2014" : signed(Math.round(a.gapLast))}
                  k="Rating gap at your last meeting"
                  tone={a.gapLast >= 0 ? "pos" : "neg"} />
            <Stat v={a.gapFirst == null || a.gapLast == null ? "\u2014" : signed(Math.round(a.gapLast - a.gapFirst))}
                  k="How the gap has moved since the first"
                  tone={a.gapLast - a.gapFirst >= 0 ? "pos" : "neg"} />
            <Stat v={a.nextWin == null ? "\u2014" : Math.round(a.nextWin * 100) + "%"}
                  k="Chance you win the next one" />
            <Stat v={a.confidence == null ? "\u2014" : Math.round(a.confidence * 100) + "%"}
                  k="Chance you are genuinely the stronger player" />
            <Stat v={a.pointedCount ? signed(Math.round(a.netPoints)) : "\u2014"}
                  k="Net rating points from this rivalry"
                  tone={a.netPoints >= 0 ? "pos" : "neg"} />
          </div>

          <div className="panel">
            <h2>Reading those last two numbers</h2>
            <p className="lede" style={{ marginBottom: 0 }}>
              They answer different questions. The chance you win the next match comes from the gap
              between your ratings, and stays near even because table tennis produces upsets. The
              chance you are genuinely stronger folds in how uncertain the system is about each of
              you, so it can be high even when a single match is close to a coin flip.
              {a.confidence == null && " That second number needs both players' standard deviations, which your file does not appear to carry — check the column mapping above."}
            </p>
            <p className="note">
              Win probability uses a logistic curve on the rating difference. Ratings Central fits its
              own probability-of-upset function, so treat it as an approximation and adjust the scale
              until the predicted wins line up with what actually happened across all your opponents.
            </p>
          </div>

          {series.length > 1 && (
            <div className="panel">
              <h2>Ratings you each brought to the table</h2>
              <ResponsiveContainer width="100%" height={H}>
                <LineChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#EEF2F5" vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                         tickFormatter={fmtShort} stroke="#64798A" fontSize={11} minTickGap={26} />
                  <YAxis stroke="#64798A" fontSize={11} domain={["dataMin - 30", "dataMax + 30"]} width={46} />
                  <Tooltip content={<GapTip />} />
                  <Line name="You" dataKey="playerRating" stroke="#17547E" strokeWidth={2}
                        dot={{ r: 3 }} isAnimationActive={false} />
                  <Line name={opponent} dataKey="opponentRating" stroke="#E8590C" strokeWidth={2}
                        dot={{ r: 3 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
              <div className="legend">
                <span><i style={{ background: "#17547E" }} />You</span>
                <span><i style={{ background: "#E8590C" }} />{opponent}</span>
              </div>
            </div>
          )}

          {series.length > 1 && (
            <div className="panel">
              <h2>The gap, and what you did with it</h2>
              <p className="lede">
                Above the line you came in higher rated. Blue dots are wins, orange are losses, so a
                blue dot below the line is an upset you caused.
              </p>
              <ResponsiveContainer width="100%" height={narrow ? 190 : 230}>
                <LineChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#EEF2F5" vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                         tickFormatter={fmtShort} stroke="#64798A" fontSize={11} minTickGap={26} />
                  <YAxis stroke="#64798A" fontSize={11} width={46} />
                  <ReferenceLine y={0} stroke="#64798A" strokeDasharray="3 3" />
                  <Tooltip content={<GapTip />} />
                  <Line dataKey="gap" stroke="#0F1B23" strokeWidth={1.5} isAnimationActive={false}
                        dot={(p) => (
                          <circle key={p.index} cx={p.cx} cy={p.cy} r={5}
                                  fill={p.payload.won ? "#17547E" : "#E8590C"}
                                  stroke="#fff" strokeWidth={1.5} />
                        )} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {a.byYear.length > 1 && (
            <div className="panel">
              <h2>Year by year</h2>
              <ResponsiveContainer width="100%" height={narrow ? 160 : 190}>
                <BarChart data={a.byYear} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#EEF2F5" vertical={false} />
                  <XAxis dataKey="year" stroke="#64798A" fontSize={11} />
                  <YAxis stroke="#64798A" fontSize={11} allowDecimals={false} width={46} />
                  <Tooltip contentStyle={{ fontSize: 13, border: "1px solid #B9C5CD", borderRadius: 3 }} />
                  <Bar dataKey="w" name="Won" stackId="s" fill="#17547E" isAnimationActive={false} />
                  <Bar dataKey="l" name="Lost" stackId="s" fill="#E8590C" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="panel">
            <h2>Every meeting</h2>
            <div className="scroll tall">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th><th className="wide">Event</th><th>Result</th><th>Score</th>
                    <th className="n">Points</th>
                    <th className="n">You</th><th className="n">Them</th><th className="n">Gap</th>
                    <th className="n">Win chance</th><th />
                  </tr>
                </thead>
                <tbody>
                  {[...meetings].reverse().map((m, i) => {
                    const both = m.playerRating != null && m.opponentRating != null;
                    const gap = both ? m.playerRating - m.opponentRating : null;
                    const evPts = eventPoints.get((m.event || "").trim().toLowerCase());
                    const pts = m.pointChange != null ? m.pointChange
                      : (evPts != null ? evPts : null);
                    const fromEvent = m.pointChange == null && evPts != null;
                    return (
                      <tr key={i}>
                        <td>{fmtDate(m.t)}</td>
                        <td className="wide">{m.event || "\u2014"}</td>
                        <td><span className={"pill " + (m.won ? "w" : "l")}>{m.won ? "W" : "L"}</span></td>
                        <td>{m.score || "\u2014"}</td>
                        <td className="n" style={{
                          color: pts == null ? undefined : (pts >= 0 ? "#17547E" : "#E8590C"),
                          opacity: fromEvent ? 0.6 : 1,
                        }}>
                          {pts == null ? "\u2014" : signed(Math.round(pts)) + (fromEvent ? "*" : "")}
                        </td>
                        <td className="n">{m.playerRating == null ? "\u2014" : Math.round(m.playerRating)}</td>
                        <td className="n">{m.opponentRating == null ? "\u2014" : Math.round(m.opponentRating)}</td>
                        <td className="n">{gap == null ? "\u2014" : signed(Math.round(gap))}</td>
                        <td className="n">{gap == null ? "\u2014" : Math.round(pWin(gap, scale) * 100) + "%"}</td>
                        <td>{both && m.won && gap < 0 ? <span className="flag">upset</span> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {usesEventFallback && (
              <p className="note">
                Values marked with an asterisk are the points you gained or lost across the whole
                event, not that single match. Your match file has no per-match points column, so
                these come from your rating-history file, matched on event name. If several of your
                matches share an event, they will all show the same figure.
              </p>
            )}
            {!hasMatchPoints && !usesEventFallback && (
              <p className="note">
                No points column was found. If your match export has one, set it in the column
                mapping above. Otherwise load your rating-history file in the Player history tab and
                the event totals will appear here instead.
              </p>
            )}
            {missingCols && (
              <p className="note">
                Ratings are missing because no rating column was matched in your file. Open the column
                mapping above and point it at the right ones.
              </p>
            )}
          </div>

          <div className="panel">
            <h2>Split by event</h2>
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th className="wide">Event</th><th className="n">Won</th><th className="n">Lost</th></tr></thead>
                <tbody>
                  {a.byEvent.map((e) => (
                    <tr key={e.name}>
                      <td className="wide">{e.name}</td>
                      <td className="n">{e.w}</td>
                      <td className="n">{e.l}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ================= shell ================= */

export default function RatingsLab() {
  const [tab, setTab] = useState("history");
  const [events, setEvents] = useState(SAMPLE);
  const [isSample, setIsSample] = useState(true);
  const [label, setLabel] = useState("Sample player");
  const [matches, setMatches] = useState([]);
  const [colMap, setColMap] = useState(null);
  const [headers, setHeaders] = useState([]);
  const [rawRows, setRawRows] = useState(null);
  const [pid, setPid] = useState("");
  const [msg, setMsg] = useState(null);
  const [over, setOver] = useState(false);

  const say = (text, bad = false) => setMsg({ text, bad });

  const handleFile = useCallback((file) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return say("That file is over 25 MB, which is far larger than any Ratings Central export. Check you picked the right one.", true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
      complete: (res) => {
        const fields = (res.meta.fields || []).filter(Boolean);
        const rows = res.data || [];
        if (!rows.length || !fields.length) return say("That file has no readable rows.", true);

        if (HISTORY_COLS.every((k) => fields.includes(k))) {
          const parsed = parseHistoryRows(rows);
          if (!parsed.length) return say("Recognised as a rating history, but no rows could be read.", true);
          setEvents(parsed);
          setIsSample(false);
          setLabel(file.name.replace(/PlayerHistory[_-]?/i, "Player ").replace(/\.csv$/i, "").trim() || "Your history");
          setTab("history");
          return say(`Loaded ${parsed.length} events.`);
        }

        const map = resolveColumns(fields);
        if (!map.opponent || !map.result || !map.date) {
          return say(
            "That file was not recognised. This app takes the rating-history export or the match-search export from Ratings Central. Headers found: " + fields.join(", "),
            true
          );
        }
        const parsed = parseMatchRows(rows, map);
        if (!parsed.length) return say("Recognised as a match file, but no rows could be read. Try adjusting the column mapping.", true);
        setHeaders(fields);
        setColMap(map);
        setRawRows(rows);
        setMatches(parsed);
        setTab("h2h");
        const opps = new Set(parsed.map((m) => m.opponent));
        say(`Loaded ${parsed.length} matches against ${opps.size} opponents.`);
      },
      error: () => say("That file could not be read.", true),
    });
  }, []);

  const reparse = useCallback((next) => {
    setColMap(next);
    if (!rawRows) return;
    const parsed = parseMatchRows(rawRows, next);
    if (parsed.length) setMatches(parsed);
    else say("That mapping produced no usable rows. Date, opponent and result all need a column.", true);
  }, [rawRows]);

  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(id);
  }, [msg]);

  return (
    <div className="rl">
      <style>{CSS}</style>

      <div className="top">
        <div className="wrap">
          <h1>Ratings Lab</h1>
          <p className="sub">
            Deeper analysis of your Ratings Central record than the site itself shows. Free, no
            account, and your data stays on your device.
          </p>
          <div className="nav" role="tablist">
            <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
              Player history
              <span className="n">Ratings, events, form</span>
            </button>
            <button role="tab" aria-selected={tab === "h2h"} onClick={() => setTab("h2h")}>
              Head to head
              <span className="n">One opponent at a time</span>
            </button>
          </div>
        </div>
      </div>

      <Privacy />

      <div className="wrap body">
        {msg && (
          <div className={"panel" + (msg.bad ? " err" : "")} style={{ padding: "13px 16px" }}>
            {msg.text}
          </div>
        )}

        {tab === "history" ? (
          <>
            {isSample && (
              <div className="panel" style={{ padding: "13px 16px" }}>
                Showing a real 61-event sample so you can see what the analysis looks like. Load your
                own file to replace it.
              </div>
            )}
            <HistoryMode
              events={events}
              label={label}
              isSample={isSample}
              pid={pid}
              setPid={setPid}
              onFile={handleFile}
              over={over}
              setOver={setOver}
              onClear={() => { setEvents(SAMPLE); setIsSample(true); setLabel("Sample player"); say("Cleared. Back to the sample."); }}
            />
          </>
        ) : (
          <H2HMode
            matches={matches}
            history={isSample ? [] : events}
            pid={pid}
            setPid={setPid}
            colMap={colMap}
            headers={headers}
            setColMap={reparse}
            onFile={handleFile}
            over={over}
            setOver={setOver}
            onClear={() => { setMatches([]); setColMap(null); setHeaders([]); setRawRows(null); say("Cleared."); }}
          />
        )}

        <div className="panel" style={{ marginTop: 22 }}>
          <h3>About the numbers</h3>
          <p className="note" style={{ marginTop: 8 }}>
            Ratings Central is a Bayesian system: a rating is a posterior mean with a standard
            deviation attached, not a single fixed number. This app keeps the deviation and shows it,
            because how sure the system is about you is as interesting as the rating itself. Ratings
            change only when an event is processed, which is why the charts step rather than curve.
          </p>
          <p className="note">
            Ratings Central owns this data and this app is not affiliated with them. It reads files
            you export yourself and never contacts their servers.
          </p>
        </div>
      </div>
    </div>
  );
}
