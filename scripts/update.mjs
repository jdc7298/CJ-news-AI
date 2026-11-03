// Midterm Desk updater. Node 20+, zero dependencies.
// Pulls headlines from the RSS/Atom feeds in config/sources.json and (optionally)
// official results from the URL(s) in config/results.json, then writes JSON into /data.
// A failing source never stops the run; it is reported in data/status.json instead.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UA = 'MidtermDeskBot/1.0 (headline aggregator; links back to original sources)';
const TIMEOUT_MS = 15000;
const MAX_PER_SOURCE = 25;
const MAX_AGE_HOURS = 72;
const HEARTBEAT_MS = 10 * 60 * 1000; // rewrite unchanged files at most this often

// ---------- helpers ----------
async function getText(url) {
  if (url.startsWith('file:')) return readFile(new URL(url), 'utf8'); // used by tests
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/csv, application/json, */*',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function clean(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENT[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

export function parseFeed(xml) {
  const items = [];
  const re = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const title = clean(tag(b, 'title'));
    let link = clean(tag(b, 'link'));
    if (!link) {
      const links = [...b.matchAll(/<link\b[^>]*>/gi)].map(x => x[0]);
      const alt = links.find(l => /rel=["']alternate["']/i.test(l)) || links.find(l => !/rel=/i.test(l)) || links[0];
      const hm = alt && alt.match(/href=["']([^"']+)["']/i);
      if (hm) link = hm[1].replace(/&amp;/g, '&');
    }
    const dateRaw = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const d = dateRaw ? new Date(dateRaw) : null;
    if (title && /^https?:\/\//i.test(link)) {
      items.push({ title, url: link, published: d && !isNaN(d) ? d.toISOString() : null });
    }
  }
  return items;
}

// ---------- topic tagging (simple, transparent keyword rules) ----------
const TOPICS = {
  House: /\bu\.?s\.? house\b|\bhouse (race|races|seat|seats|control|majority|battle)\b|congressional district|\bspeaker\b/i,
  Senate: /\bsenate\b/i,
  Governors: /\bgovernor|gubernatorial/i,
  'Ballot measures': /ballot (measure|initiative|question|proposal)|referendum|\bamendment\b|proposition|\bprop\.? \d|\bmeasure \d/i,
  'Voting & access': /polling (place|site|location)|voter id|long lines|early voting|mail[- ]in|absentee|voter registration|ballot drop|turnout/i,
  'Recounts & courts': /recount|lawsuit|\bcourt\b|\bjudge\b|certif(y|ied|ication)/i,
  Redistricting: /redistrict|gerrymander/i,
  'Misinformation & AI': /misinformation|disinformation|deepfake|\bAI\b|artificial intelligence/i,
  'North Dakota': /north dakota|bismarck|fargo|grand forks|minot|williston|dickinson|jamestown|mandan|devils lake|fedorchak|hoeven|cramer|armstrong/i,
};
const ELECTION = /election|midterm|\bvot(e|er|ers|ing)\b|ballot|\bpolls?\b|campaign|candidate|recount|primary|\bsenate\b|\bhouse\b|governor|congress/i;

function tagItem(item, source) {
  const topics = Object.entries(TOPICS).filter(([, re]) => re.test(item.title)).map(([k]) => k);
  if (source.group === 'Local ND' && !topics.includes('North Dakota')) topics.push('North Dakota');
  return { ...item, topics, election: ELECTION.test(item.title) || topics.length > 0 };
}

// ---------- news ----------
async function updateNews(now) {
  const cfg = JSON.parse(await readFile(path.join(CONFIG_DIR, 'sources.json'), 'utf8'));
  const status = [];
  const all = [];
  await Promise.all(
    cfg.sources.map(async s => {
      const t0 = Date.now();
      try {
        const xml = await getText(s.url);
        const parsed = parseFeed(xml);
        if (!parsed.length) throw new Error('feed parsed but contained no items');
        const cutoff = now - MAX_AGE_HOURS * 3600 * 1000;
        const fresh = parsed
          .filter(i => !i.published || new Date(i.published).getTime() >= cutoff)
          .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
          .slice(0, MAX_PER_SOURCE);
        for (const it of fresh) {
          all.push({ id: s.id + '|' + it.url, source: s.name, sourceId: s.id, group: s.group, ...tagItem(it, s) });
        }
        status.push({ id: s.id, name: s.name, group: s.group, ok: true, count: fresh.length, error: null, fetchedAt: new Date(now).toISOString(), ms: Date.now() - t0 });
      } catch (e) {
        status.push({ id: s.id, name: s.name, group: s.group, ok: false, count: 0, error: String(e.message || e).slice(0, 160), fetchedAt: new Date(now).toISOString(), ms: Date.now() - t0 });
      }
    })
  );
  // dedupe by url, newest first
  const seen = new Set();
  const items = all
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .filter(i => (seen.has(i.url) ? false : seen.add(i.url)))
    .slice(0, 800);
  status.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return { news: { generatedAt: new Date(now).toISOString(), items }, status: { generatedAt: new Date(now).toISOString(), sources: status } };
}

// ---------- results ----------
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

const num = v => {
  const n = parseFloat(String(v ?? '').replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Turns a CSV (one row per candidate per contest) into the normalized shape the page reads.
// Column names are matched loosely; override with "columns" in config/results.json if needed.
export function normalizeCSV(text, overrides = {}) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const header = rows[0].map(h => h.trim());
  const find = (re, key) => {
    if (overrides[key]) return header.findIndex(h => h.toLowerCase() === overrides[key].toLowerCase());
    return header.findIndex(h => re.test(h));
  };
  const col = {
    contest: find(/contest|race|office|title/i, 'contest'),
    candidate: find(/candidate|choice|^name$/i, 'candidate'),
    party: find(/party/i, 'party'),
    votes: find(/^votes?$|total.?votes|vote.?count|^count$/i, 'votes'),
    reporting: find(/precincts?.*report/i, 'reporting'),
    total: find(/total.?precincts|precincts?.*total/i, 'totalPrecincts'),
  };
  if (col.contest < 0 || col.candidate < 0 || col.votes < 0) {
    throw new Error('could not find contest/candidate/votes columns; headers were: ' + header.join(' | '));
  }
  const map = new Map();
  for (const r of rows.slice(1)) {
    const name = (r[col.contest] || '').trim();
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, candidates: [], precinctsReporting: null, precinctsTotal: null });
    const c = map.get(name);
    c.candidates.push({ name: (r[col.candidate] || '').trim(), party: col.party >= 0 ? (r[col.party] || '').trim() : '', votes: num(r[col.votes]) ?? 0 });
    if (col.reporting >= 0) c.precinctsReporting = num(r[col.reporting]);
    if (col.total >= 0) c.precinctsTotal = num(r[col.total]);
  }
  return finishContests([...map.values()]);
}

function finishContests(contests) {
  for (const c of contests) {
    const total = c.candidates.reduce((a, x) => a + (x.votes || 0), 0);
    c.totalVotes = total;
    for (const x of c.candidates) x.pct = total ? Math.round((x.votes / total) * 1000) / 10 : 0;
    c.candidates.sort((a, b) => b.votes - a.votes);
  }
  return contests;
}

async function updateResults(now) {
  const file = path.join(CONFIG_DIR, 'results.json');
  if (!existsSync(file)) return { results: null, status: [] };
  const cfg = JSON.parse(await readFile(file, 'utf8'));
  const out = {};
  const status = [];
  for (const [key, block] of Object.entries(cfg)) {
    if (key.startsWith('_') || !block || block.enabled === false) continue;
    const contests = [];
    for (const src of block.sources || []) {
      if (!src.url) continue;
      const t0 = Date.now();
      try {
        const text = await getText(src.url);
        const fmt = src.format && src.format !== 'auto' ? src.format : /^\s*[\[{]/.test(text) ? 'json' : 'csv';
        let got;
        if (fmt === 'json') {
          const j = JSON.parse(text);
          got = finishContests(Array.isArray(j) ? j : j.contests); // already-normalized JSON
          if (!Array.isArray(got)) throw new Error('JSON must be an array of contests or {contests:[...]}');
        } else {
          got = normalizeCSV(text, src.columns || {});
        }
        contests.push(...got);
        status.push({ id: 'results-' + key, name: src.label || src.url, group: 'Official results', ok: true, count: got.length, error: null, fetchedAt: new Date(now).toISOString(), ms: Date.now() - t0 });
      } catch (e) {
        status.push({ id: 'results-' + key, name: src.label || src.url, group: 'Official results', ok: false, count: 0, error: String(e.message || e).slice(0, 200), fetchedAt: new Date(now).toISOString(), ms: Date.now() - t0 });
      }
    }
    if (contests.length) out[key] = { generatedAt: new Date(now).toISOString(), source: block.label || key, contests };
  }
  return { results: out, status };
}

// ---------- writing (avoid noisy commits when nothing changed) ----------
function strip(o) {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (!['generatedAt', 'fetchedAt', 'ms'].includes(k)) r[k] = strip(v);
    return r;
  }
  return o;
}
async function writeIfChanged(file, obj, now) {
  let old = null;
  try { old = JSON.parse(await readFile(file, 'utf8')); } catch {}
  if (old) {
    const same = JSON.stringify(strip(old)) === JSON.stringify(strip(obj));
    const age = old.generatedAt ? now - new Date(old.generatedAt).getTime() : Infinity;
    if (same && age < HEARTBEAT_MS) return false;
  }
  await writeFile(file, JSON.stringify(obj, null, 1) + '\n');
  return true;
}

async function main() {
  const now = Date.now();
  await mkdir(DATA_DIR, { recursive: true });
  const { news, status } = await updateNews(now);
  const { results, status: rstatus } = await updateResults(now);
  status.sources.push(...rstatus);
  const changed = [];
  if (await writeIfChanged(path.join(DATA_DIR, 'news.json'), news, now)) changed.push('news');
  if (await writeIfChanged(path.join(DATA_DIR, 'status.json'), status, now)) changed.push('status');
  if (results) {
    for (const [key, val] of Object.entries(results)) {
      if (await writeIfChanged(path.join(DATA_DIR, `${key}_results.json`), val, now)) changed.push(key + '_results');
    }
  }
  const bad = status.sources.filter(s => !s.ok);
  console.log(`ok: ${status.sources.length - bad.length}/${status.sources.length} sources, ${news.items.length} headlines, wrote: ${changed.join(', ') || 'nothing (unchanged)'}`);
  for (const b of bad) console.log(`  FAILED ${b.name}: ${b.error}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
