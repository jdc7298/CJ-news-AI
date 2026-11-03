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

// ---- North Dakota Secretary of State "General Election" CSV export ----
// One row per contest x location x candidate. Location ID 38xxx = a county; 4-digit IDs are
// precincts/sub-areas inside a county, which are ignored here so nothing is double counted.
// The smaller "State" export has no Location ID column and uses county names only.
const ND_STATEWIDE = /^(Secretary of State|Attorney General|Agriculture Commissioner|Public Service Commissioner|Tax Commissioner|Superintendent of Public Instruction|Justice of the Supreme Court)/i;
const ND_PARTY = { REP: 'R', DEM: 'D-NPL', IND: 'Ind.', LIB: 'Lib.', NON: '' };

export function ndCategory(name) {
  if (/^Representative in Congress/i.test(name)) return 'Congress';
  if (ND_STATEWIDE.test(name)) return 'Statewide';
  if (/^(Initiated )?Constitutional Measure/i.test(name)) return 'Ballot measures';
  if (/^State (Senator|Representative)/i.test(name)) return 'Legislature';
  return 'Local';
}

export function isNDSOS(headerRow) {
  const h = headerRow.map(x => x.trim().toLowerCase());
  return h.includes('candidate vote percentage') && h.includes('contest id') && (h.includes('location id') || h.includes('location'));
}

export function normalizeNDSOS(text) {
  const rows = parseCSV(text);
  const header = rows[0].map(h => h.trim());
  const ix = n => header.findIndex(h => h.toLowerCase() === n.toLowerCase());
  const c = {
    id: ix('Contest ID'), name: ix('Contest Name'),
    locId: ix('Location ID'), loc: ix('Location Name') >= 0 ? ix('Location Name') : ix('Location'),
    pt: ix('Total Precincts'), pr: ix('Precincts Reporting'), pp: ix('Precincts Partially Reporting'),
    cid: ix('Candidate ID'), cname: ix('Candidate Name'), party: ix('Party ID'), votes: ix('Candidate Votes'),
  };
  for (const [k, v] of Object.entries(c)) if (v < 0 && !['locId', 'party'].includes(k)) throw new Error('ND export is missing column for ' + k);
  const map = new Map();
  for (const r of rows.slice(1)) {
    if (c.locId >= 0 && !/^38\d{3}$/.test((r[c.locId] || '').trim())) continue; // county-level rows only
    const cid = r[c.id];
    const name = (r[c.name] || '').replace(/\s+/g, ' ').trim();
    if (!cid || !name) continue;
    let k = map.get(cid);
    if (!k) { k = { id: cid, name, category: ndCategory(name), precinctsTotal: 0, precinctsReporting: 0, precinctsPartial: 0, cands: new Map(), counties: {} }; map.set(cid, k); }
    const county = (r[c.loc] || '').trim();
    const pt = num(r[c.pt]) || 0, pr = num(r[c.pr]) || 0, pp = num(r[c.pp]) || 0;
    let cty = k.counties[county];
    if (!cty) { cty = k.counties[county] = { pt, pr, pp, v: {} }; k.precinctsTotal += pt; k.precinctsReporting += pr; k.precinctsPartial += pp; }
    const candId = r[c.cid];
    let cn = (r[c.cname] || '').replace(/\s+/g, ' ').trim();
    if (/^write-?in$/i.test(cn)) cn = 'Write-in';
    const partyRaw = c.party >= 0 ? (r[c.party] || '').trim().toUpperCase() : '';
    const party = partyRaw in ND_PARTY ? ND_PARTY[partyRaw] : partyRaw;
    const votes = num(r[c.votes]) || 0;
    cty.v[candId] = (cty.v[candId] || 0) + votes;
    const cand = k.cands.get(candId) || { id: candId, name: cn, party, votes: 0 };
    cand.votes += votes;
    k.cands.set(candId, cand);
  }
  const out = [];
  for (const k of map.values()) {
    out.push({ id: k.id, name: k.name, category: k.category, precinctsTotal: k.precinctsTotal, precinctsReporting: k.precinctsReporting,
      precinctsPartial: k.precinctsPartial, candidates: [...k.cands.values()], counties: k.counties });
  }
  const order = { Congress: 0, Statewide: 1, 'Ballot measures': 2, Legislature: 3, Local: 4 };
  out.sort((a, b) => order[a.category] - order[b.category] || a.name.localeCompare(b.name, 'en', { numeric: true }));
  return finishContests(out);
}


// ---- North Dakota results API (the same public JSON feed the official results site uses) ----
const ND_TYPE_CATEGORY = { LEG: 'Legislature', JUD: 'Judicial', CW: 'Local', CON: 'Local', MUN: 'Local', SCH: 'Local' };
const ND_TYPE_LABEL = { SW: 'State', LEG: 'Legislative', JUD: 'Judicial', CW: 'County', CON: 'Conservation', MUN: 'City', SCH: 'School' };
const ND_PARTY_SHORT = { REP: 'R', DEM: 'D-NPL', IND: 'Ind.', LIB: 'Lib.', CON: 'Con.', GRE: 'Green', OTH: 'Other', ADP: 'American Delta', NON: '' };

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(e => ({ __err: e })); }
  }));
  return out;
}

async function fetchNDApi(block, now, status) {
  const base = (block.api || 'https://api.resultsnd.sos.nd.gov').replace(/\/$/, '');
  const cId = block.cId || 'north-dakota';
  const eid = String(block.electionID || '');
  const rec = (id, name, ok, count, error, ms) => status.push({ id, name, group: 'Official results', ok, count, error, fetchedAt: new Date(now).toISOString(), ms });
  const J = async (pathQ, id, name, quiet) => {
    const t0 = Date.now();
    try {
      const j = JSON.parse(await getText(`${base}/${pathQ}`));
      if (!quiet) rec(id, name, true, 1, null, Date.now() - t0);
      return j;
    } catch (e) {
      if (!quiet) rec(id, name, false, 0, String(e.message || e).slice(0, 160), Date.now() - t0);
      throw e;
    }
  };
  const safe = async (...a) => { try { return await J(...a); } catch { return null; } };

  const list = await safe(`Contest/GetContestSearchList?cid=${cId}&electionID=${eid}`, 'nd-list', 'ND contest list');
  if (!list?.response?.contests) return null;
  const info = await safe(`Election/GetElectionInfo?cId=${cId}&electionID=${eid}`, 'nd-info', 'ND election info');
  const meta = list.response.contests;
  const countyName = {};
  const districtCounties = {};
  for (const [k, v] of Object.entries(info?.response?.locations || {})) {
    if (/^38\d{3}$/.test(k)) countyName[k] = v.locationName;
  }
  for (const [k, v] of Object.entries(info?.response?.locations || {})) {
    if (!/^38\d{3}$/.test(k)) districtCounties[k] = Object.keys(v.locations || {}).map(x => countyName[x]).filter(Boolean);
  }

  // 1) results by contest type (statewide, legislative, judicial, county, ...)
  const types = block.types || ['SW', 'LEG', 'JUD', 'CW', 'CON', 'MUN', 'SCH'];
  const results = new Map();
  let top = null;
  await Promise.all(types.map(async t => {
    const r = await safe(`Contest/GetContestResults?cId=${cId}&electionID=${eid}&contestType=${t}`, 'nd-type-' + t, `ND results: ${ND_TYPE_LABEL[t] || t} contests`);
    const cs = r?.response?.contests;
    if (cs && typeof cs === 'object') {
      for (const [id, c] of Object.entries(cs)) results.set(String(id), { c, type: t });
      if (t === 'SW' || !top) top = r;
    }
  }));

  // 2) anything still missing: ask county by county (what the official site does when you pick a county)
  const missing = Object.keys(meta).filter(id => !results.has(id));
  const sweep = new Map();
  if (missing.length && block.countySweep !== false) {
    const t0 = Date.now();
    const fipsList = Object.keys(countyName);
    const got = await pool(fipsList, 4, async fips => {
      const r = await J(`Contest/GetContestResults?cId=${cId}&electionID=${eid}&locationId=${fips}`, 'x', 'x', true);
      for (const [id, c] of Object.entries(r?.response?.contests || {})) {
        if (!results.has(String(id)) && meta[id]) {
          if (!sweep.has(String(id))) sweep.set(String(id), {});
          sweep.get(String(id))[fips] = c;
        }
      }
      return true;
    });
    const bad = got.filter(x => x?.__err).length;
    rec('nd-sweep', `ND results: county-by-county fill-in (${missing.length} contests)`, bad < fipsList.length / 2, fipsList.length - bad, bad ? `${bad} of ${fipsList.length} counties failed` : null, Date.now() - t0);
  }

  // 3) normalize
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const toVotes = x => num(x?.totalVotes) || 0;
  const contests = [];
  for (const [id, m] of Object.entries(meta)) {
    const name = clean(m.contestName);
    const type = m.contestTypeCode;
    const choiceMeta = m.choices || {};
    const cands = new Map();
    const counties = {};
    let pt = 0, pr = 0, pp = 0;
    const addChoice = (ch) => {
      const cm = choiceMeta[ch.choiceID] || {};
      const cn = clean(cm.name) || ch.choiceID;
      const pid = (ch.partyID || cm.partyID || '').trim();
      const cand = cands.get(ch.choiceID) || { id: String(ch.choiceID), name: /^write-?in$/i.test(cn) ? 'Write-in' : cn, party: pid in ND_PARTY_SHORT ? ND_PARTY_SHORT[pid] : pid, votes: 0, order: cm.order ?? 99 };
      cand.votes += toVotes(ch);
      if (ch.isWinner === true || ch.isWinner === 'True') cand.winner = true;
      cands.set(String(ch.choiceID), cand);
    };
    const addCounty = (fips, loc) => {
      const cn = countyName[fips]; if (!cn || !loc) return;
      const v = {};
      for (const ch of loc.choices || []) v[ch.choiceID] = toVotes(ch);
      counties[cn] = { pt: num(loc.totalPrecincts) || 0, pr: num(loc.precinctsReporting) || 0, pp: num(loc.precinctsPartiallyReporting) || 0, v };
    };
    const direct = results.get(id);
    if (direct) {
      const c = direct.c;
      pt = num(c.totalPrecincts) || 0; pr = num(c.precinctsReporting) || 0; pp = num(c.precinctsPartiallyReporting) || 0;
      for (const ch of c.choices || []) addChoice(ch);
      for (const [lid, loc] of Object.entries(c.locations || {})) addCounty(lid, loc);
    } else if (sweep.has(id)) {
      for (const [fips, c] of Object.entries(sweep.get(id))) {
        for (const ch of c.choices || []) addChoice(ch);
        addCounty(fips, c);
        pt += num(c.totalPrecincts) || 0; pr += num(c.precinctsReporting) || 0; pp += num(c.precinctsPartiallyReporting) || 0;
      }
    } else {
      // no results fetched for this contest yet: list its candidates at zero so it still shows up
      for (const ch of Object.values(choiceMeta)) addChoice({ choiceID: ch.id, partyID: ch.partyID, totalVotes: 0 });
    }
    const category = type === 'SW' ? ndCategory(name) : (ND_TYPE_CATEGORY[type] || 'Local');
    const contest = { id, name, category, type, typeLabel: ND_TYPE_LABEL[type] || type, voteFor: num(m.voteFor) || 1, precinctsTotal: pt, precinctsReporting: pr, precinctsPartial: pp,
      candidates: [...cands.values()].sort((a, b) => a.order - b.order), counties, hasResults: Boolean(direct || sweep.has(id)) };
    const dm = name.match(/District (\d{2})\b/);
    if (!Object.keys(counties).length && type === 'LEG' && dm && districtCounties[dm[1]]?.length) contest.inCounties = districtCounties[dm[1]];
    contests.push(contest);
  }
  const order = { Congress: 0, Statewide: 1, 'Ballot measures': 2, Legislature: 3, Judicial: 4, Local: 5 };
  contests.sort((a, b) => order[a.category] - order[b.category] || a.name.localeCompare(b.name, 'en', { numeric: true }));
  finishContests(contests);
  for (const c of contests) for (const x of c.candidates) delete x.order;
  const t = top?.turnout || {};
  return {
    contests,
    extra: {
      officialLastUpdated: top?.lastUpdated || null,
      isOfficial: top?.isOfficial === true || top?.isOfficial === 'True',
      turnout: top ? { registeredVoters: num(t.registeredVoters), precinctsReporting: num(t.precinctsReporting), precinctsPartiallyReporting: num(t.precinctsPartiallyReporting), totalPrecincts: num(t.totalPrecincts), totalBallotsCast: num(t.totalBallotsCast) } : null,
    },
  };
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
    if (block.api || block.electionID) {
      const got = await fetchNDApi(block, now, status);
      if (got && got.contests.length) out[key] = { generatedAt: new Date(now).toISOString(), source: block.label || key, ...got.extra, contests: got.contests };
      continue;
    }
    const contests = [];
    const seenIds = new Set();
    for (const src of block.sources || []) {
      if (!src.url) continue;
      const t0 = Date.now();
      try {
        const text = await getText(src.url);
        let fmt = src.format && src.format !== 'auto' ? src.format : /^\s*[\[{]/.test(text) ? 'json' : 'csv';
        let got;
        if (fmt === 'json') {
          const j = JSON.parse(text);
          got = finishContests(Array.isArray(j) ? j : j.contests); // already-normalized JSON
          if (!Array.isArray(got)) throw new Error('JSON must be an array of contests or {contests:[...]}');
        } else if (fmt === 'nd-sos' || (fmt === 'csv' && isNDSOS(parseCSV(text.slice(0, 2000).split(/\r?\n/)[0] || '')[0] || []))) {
          got = normalizeNDSOS(text);
        } else {
          got = normalizeCSV(text, src.columns || {});
        }
        for (const g of got) {
          const key = g.id ?? g.name;
          if (!seenIds.has(key)) { seenIds.add(key); contests.push(g); } // first source wins on duplicates
        }
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
async function writeIfChanged(file, obj, now, compact = false) {
  let old = null;
  try { old = JSON.parse(await readFile(file, 'utf8')); } catch {}
  if (old) {
    const same = JSON.stringify(strip(old)) === JSON.stringify(strip(obj));
    const age = old.generatedAt ? now - new Date(old.generatedAt).getTime() : Infinity;
    if (same && age < HEARTBEAT_MS) return false;
  }
  await writeFile(file, (compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 1)) + '\n');
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
      if (await writeIfChanged(path.join(DATA_DIR, `${key}_results.json`), val, now, true)) changed.push(key + '_results');
    }
  }
  const bad = status.sources.filter(s => !s.ok);
  console.log(`ok: ${status.sources.length - bad.length}/${status.sources.length} sources, ${news.items.length} headlines, wrote: ${changed.join(', ') || 'nothing (unchanged)'}`);
  for (const b of bad) console.log(`  FAILED ${b.name}: ${b.error}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
