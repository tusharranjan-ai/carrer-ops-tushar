#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Two kinds of sources, both configured in portals.yml:
 *
 *   1. tracked_companies — company career boards via their public ATS APIs:
 *      Greenhouse, Ashby, Lever, Workday, SmartRecruiters.
 *   2. job_search — keyword searches across job aggregators:
 *      JSearch (Google for Jobs index: LinkedIn, Indeed, Glassdoor,
 *      ZipRecruiter…), Adzuna, Remotive. JSearch and Adzuna need free
 *      API keys in .env; sources without keys are skipped.
 *
 * Results are filtered by title keywords, location and posting age,
 * deduplicated against history, and appended to pipeline.md +
 * scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan everything enabled
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company (skips job_search)
 *   node scan.mjs --no-search      # tracked companies only
 *   node scan.mjs --search-only    # job_search only
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const WORKDAY_PAGE_SIZE = 20;         // Workday rejects larger pages
const SMARTRECRUITERS_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 5;
const USER_AGENT = 'career-ops-scanner (+https://github.com/santifer/career-ops)';

// ── Keyword matching ────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive keyword matcher. "AI" matches "AI Engineer"
 * but not "Maintenance"; "ML" doesn't match "HTML". A trailing plural "s"
 * is allowed so "Agent" also matches "Agents". Short all-caps codes
 * ("US", "IN", "OR") match case-sensitively so they don't hit "us", "in", "or".
 */
export function buildKeywordMatcher(keywords) {
  const cleaned = (keywords || []).map(k => String(k).trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const isCode = (k) => k.length <= 3 && /^[A-Z]+$/.test(k);
  const toRegex = (list, flags) => list.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${list.map(escapeRegex).join('|')})(?:e?s)?(?![A-Za-z0-9])`, flags)
    : null;
  const codes = toRegex(cleaned.filter(isCode), '');
  const words = toRegex(cleaned.filter(k => !isCode(k)), 'i');
  return (text) => !!text && ((codes && codes.test(text)) || (words && words.test(text)));
}

export function buildTitleFilter(titleFilter) {
  const positive = buildKeywordMatcher(titleFilter?.positive);
  const negative = buildKeywordMatcher(titleFilter?.negative);
  return (title) => (!positive || positive(title)) && !(negative && negative(title));
}

/**
 * Location filter. `exclude` always wins; if `include` is set, the location
 * must match it. Unknown locations ("", "N/A", "3 Locations") pass unless
 * keep_unknown is false.
 */
export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const include = buildKeywordMatcher(locationFilter.include);
  const exclude = buildKeywordMatcher(locationFilter.exclude);
  const keepUnknown = locationFilter.keep_unknown !== false;
  return (location) => {
    const loc = (location || '').trim();
    if (!loc || /^n\/?a$/i.test(loc) || /^\d+\s+locations?$/i.test(loc)) return keepUnknown;
    if (exclude && exclude(loc)) return false;
    return !include || include(loc);
  };
}

// ── Dates ───────────────────────────────────────────────────────────

/** Workday reports age as text: "Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago". */
export function parseWorkdayPostedOn(text, now = new Date()) {
  if (!text) return null;
  const t = text.toLowerCase();
  let days = null;
  if (t.includes('today')) days = 0;
  else if (t.includes('yesterday')) days = 1;
  else {
    const m = t.match(/(\d+)\+?\s*days?/);
    if (m) days = parseInt(m[1], 10);
  }
  if (days === null) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function isStale(postedAt, maxAgeDays, now = new Date()) {
  if (!maxAgeDays || !postedAt) return false;
  const ts = Date.parse(postedAt);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts > maxAgeDays * 86_400_000;
}

// ── Source detection (tracked companies) ────────────────────────────

export function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse boards (US + EU)
  const ghMatch = url.match(/(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io\/([^/?#]+)/);
  if (ghMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs`,
    };
  }

  // Workday: https://{tenant}.wd{N}.myworkdayjobs.com/[{locale}/]{site}
  const wdMatch = url.match(/^https?:\/\/(([^./]+)\.wd\d+\.myworkdayjobs\.com)\/([^?#]*)/);
  if (wdMatch) {
    const [, host, tenant, path] = wdMatch;
    const site = path.split('/').filter(s => s && !/^[a-z]{2}-[A-Z]{2}$/.test(s))[0];
    if (site) {
      return {
        type: 'workday',
        url: `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
        publicBase: `https://${host}/${site}`,
      };
    }
  }

  // SmartRecruiters: explicit id, or jobs./careers.smartrecruiters.com/{id}
  const srMatch = url.match(/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/);
  const srId = company.smartrecruiters || srMatch?.[1];
  if (srId) {
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${srId}/postings`,
      companyId: srId,
    };
  }

  return null;
}

// ── Parsers ─────────────────────────────────────────────────────────

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedAt: j.first_published || j.updated_at || null,
  }));
}

export function parseAshby(json, companyName) {
  return (json.jobs || [])
    .filter(j => j.isListed !== false)
    .map(j => ({
      title: j.title || '',
      url: j.jobUrl || '',
      company: companyName,
      location: [j.location, j.isRemote && !/remote/i.test(j.location || '') ? 'Remote' : '']
        .filter(Boolean).join(' · '),
      postedAt: j.publishedAt || null,
    }));
}

export function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

export function parseWorkday(json, companyName, publicBase, now = new Date()) {
  return (json.jobPostings || []).map(j => ({
    title: j.title || '',
    url: j.externalPath ? `${publicBase}${j.externalPath}` : '',
    company: companyName,
    location: j.locationsText || '',
    postedAt: parseWorkdayPostedOn(j.postedOn, now),
  }));
}

export function parseSmartRecruiters(json, companyName, companyId) {
  return (json.content || []).map(j => {
    const loc = j.location || {};
    const place = loc.fullLocation || [loc.city, loc.region, loc.country?.toUpperCase()].filter(Boolean).join(', ');
    return {
      title: j.name || '',
      url: `https://jobs.smartrecruiters.com/${companyId}/${j.id}`,
      company: companyName,
      location: [place, loc.remote ? 'Remote' : ''].filter(Boolean).join(' · '),
      postedAt: j.releasedDate || null,
    };
  });
}

export function parseJSearch(json) {
  return (json.data || []).map(j => ({
    title: j.job_title || '',
    url: j.job_apply_link || j.job_google_link || '',
    company: j.employer_name || '',
    location: [
      [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', '),
      j.job_is_remote ? 'Remote' : '',
    ].filter(Boolean).join(' · '),
    postedAt: j.job_posted_at_datetime_utc || null,
    via: j.job_publisher || '',
  }));
}

export function parseAdzuna(json) {
  return (json.results || []).map(j => ({
    title: stripHtml(j.title),
    url: j.redirect_url || '',
    company: stripHtml(j.company?.display_name),
    location: j.location?.display_name || '',
    postedAt: j.created || null,
  }));
}

export function parseRemotive(json) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.url || '',
    company: j.company_name || '',
    location: `Remote · ${j.candidate_required_location || ''}`.replace(/ · $/, ''),
    postedAt: j.publication_date || null,
  }));
}

// ── HTTP with timeout + retry ───────────────────────────────────────

async function fetchJson(url, init = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(lastErr.retryAfterMs || 1000 * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers || {}) },
        signal: controller.signal,
      });
      if (res.ok) return await res.json();
    } catch (err) {
      // Network error or timeout — retryable
      lastErr = err.name === 'AbortError' ? new Error('timeout') : err;
      continue;
    } finally {
      clearTimeout(timer);
    }

    lastErr = new Error(`HTTP ${res.status}`);
    // Only 429 and 5xx are worth retrying
    if (res.status !== 429 && res.status < 500) throw lastErr;
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    if (retryAfter > 0) lastErr.retryAfterMs = Math.min(retryAfter, 10) * 1000;
  }
  throw lastErr;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fetchers ────────────────────────────────────────────────────────

async function fetchCompany(company, api, opts) {
  switch (api.type) {
    case 'greenhouse':
      return parseGreenhouse(await fetchJson(api.url), company.name);
    case 'ashby':
      return parseAshby(await fetchJson(api.url), company.name);
    case 'lever':
      return parseLever(await fetchJson(api.url), company.name);
    case 'workday':
      return fetchWorkday(company, api, opts);
    case 'smartrecruiters':
      return fetchSmartRecruiters(company, api, opts);
    default:
      return [];
  }
}

/** Workday and SmartRecruiters boards can hold thousands of jobs — search server-side. */
function searchTermsFor(company, opts) {
  const terms = company.search_terms || opts.atsSearchTerms;
  return terms && terms.length ? terms : [''];
}

async function fetchWorkday(company, api, opts) {
  const jobs = [];
  const maxPages = company.max_pages || opts.maxPages;
  for (const term of searchTermsFor(company, opts)) {
    for (let page = 0; page < maxPages; page++) {
      const json = await fetchJson(api.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset: page * WORKDAY_PAGE_SIZE, searchText: term }),
      });
      const batch = parseWorkday(json, company.name, api.publicBase);
      jobs.push(...batch);
      if (batch.length < WORKDAY_PAGE_SIZE) break;
    }
  }
  return jobs;
}

async function fetchSmartRecruiters(company, api, opts) {
  const jobs = [];
  const maxPages = company.max_pages || opts.maxPages;
  for (const term of searchTermsFor(company, opts)) {
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ limit: SMARTRECRUITERS_PAGE_SIZE, offset: page * SMARTRECRUITERS_PAGE_SIZE });
      if (term) params.set('q', term);
      const json = await fetchJson(`${api.url}?${params}`);
      const batch = parseSmartRecruiters(json, company.name, api.companyId);
      jobs.push(...batch);
      if (batch.length < SMARTRECRUITERS_PAGE_SIZE) break;
    }
  }
  return jobs;
}

// JSearch accepts a fixed set of date windows
function jsearchDatePosted(maxAgeDays) {
  if (!maxAgeDays) return 'all';
  if (maxAgeDays <= 1) return 'today';
  if (maxAgeDays <= 3) return '3days';
  if (maxAgeDays <= 7) return 'week';
  if (maxAgeDays <= 31) return 'month';
  return 'all';
}

/** Build one task per (source, query). Sources missing API keys are reported, not fetched. */
export function buildSearchTasks(jobSearch, env, maxAgeDays) {
  const tasks = [];
  const skipped = [];
  if (!jobSearch) return { tasks, skipped };
  const queries = jobSearch.queries || [];
  const location = jobSearch.location || '';
  const sources = jobSearch.sources || {};

  const js = sources.jsearch;
  if (js && js.enabled !== false) {
    if (!env.JSEARCH_API_KEY) skipped.push('jsearch (set JSEARCH_API_KEY)');
    else for (const q of queries) {
      const params = new URLSearchParams({
        query: location ? `${q} in ${location}` : q,
        page: '1',
        num_pages: String(js.num_pages || 1),
        date_posted: jsearchDatePosted(maxAgeDays),
      });
      if (js.country) params.set('country', js.country);
      tasks.push({
        source: 'jsearch', query: q,
        url: `https://jsearch.p.rapidapi.com/search?${params}`,
        init: { headers: { 'x-rapidapi-key': env.JSEARCH_API_KEY, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' } },
        parse: parseJSearch,
      });
    }
  }

  const az = sources.adzuna;
  if (az && az.enabled !== false) {
    if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) skipped.push('adzuna (set ADZUNA_APP_ID + ADZUNA_APP_KEY)');
    else for (const q of queries) {
      const params = new URLSearchParams({
        app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY,
        what: q, results_per_page: '50', sort_by: 'date', 'content-type': 'application/json',
      });
      if (maxAgeDays) params.set('max_days_old', String(maxAgeDays));
      if (az.where) params.set('where', az.where);
      tasks.push({
        source: 'adzuna', query: q,
        url: `https://api.adzuna.com/v1/api/jobs/${az.country || 'us'}/search/1?${params}`,
        parse: parseAdzuna,
      });
    }
  }

  const rm = sources.remotive;
  if (rm && rm.enabled !== false) {
    // Remotive asks for a handful of calls per day — use its own short query list if given
    for (const q of rm.queries || queries) {
      tasks.push({
        source: 'remotive', query: q,
        url: `https://remotive.com/api/remote-jobs?${new URLSearchParams({ search: q, limit: '100' })}`,
        parse: parseRemotive,
      });
    }
  }

  return { tasks, skipped };
}

// ── Dedup ───────────────────────────────────────────────────────────

/** Same role from two sources (ATS + LinkedIn via JSearch) should dedupe. */
export function roleKey(company, title) {
  const c = (company || '').toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|plc|gmbh|technologies|labs)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  const t = (title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${c}::${t}`;
}

function loadSeenUrls() {
  const seen = new Set();

  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();

  // scan-history.tsv: url, first_seen, portal, title, company, status
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const cols = line.split('\t');
      if (cols.length >= 5) seen.add(roleKey(cols[4], cols[3]));
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim();
      const role = match[2].trim();
      if (company && role && company.toLowerCase() !== 'company') {
        seen.add(roleKey(company, role));
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, insertAt) + `\n${marker}\n\n${lines}\n\n` + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const nextSection = text.indexOf('\n## ', idx + marker.length);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + `\n${lines}\n` + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const clean = (s) => String(s || '').replace(/[\t\n]/g, ' ');
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${clean(o.title)}\t${clean(o.company)}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Proxy support ───────────────────────────────────────────────────

/**
 * Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1
 * (Node >= 22.21 / 24). Behind a proxy, re-run ourselves with it set.
 */
function reexecWithProxyIfNeeded() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (!proxy || process.env.NODE_USE_ENV_PROXY || major < 22) return;
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=UNDICI-EHPA', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } },
  );
  process.exit(result.status ?? 1);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  reexecWithProxyIfNeeded();
  dotenv.config({ quiet: true });

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const skipSearch = args.includes('--no-search') || !!filterCompany;
  const skipCompanies = args.includes('--search-only');

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }
  mkdirSync('data', { recursive: true });

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const maxAgeDays = config.max_age_days || null;
  const opts = {
    atsSearchTerms: config.ats_search_terms || [],
    maxPages: config.ats_max_pages || DEFAULT_MAX_PAGES,
  };

  // 2. Build fetch jobs: tracked companies + keyword searches
  const enabled = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));
  const targets = skipCompanies ? [] : enabled
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);
  const skippedCount = skipCompanies ? 0 : enabled.length - targets.length;

  const { tasks: searchTasks, skipped: skippedSources } = skipSearch
    ? { tasks: [], skipped: [] }
    : buildSearchTasks(config.job_search, process.env, maxAgeDays);

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (searchTasks.length) console.log(`Running ${searchTasks.length} job-board searches`);
  for (const s of skippedSources) console.log(`  (skipped ${s})`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch
  const date = new Date().toISOString().slice(0, 10);
  const stats = { found: 0, title: 0, location: 0, stale: 0, dupes: 0 };
  const perSource = {};
  const newOffers = [];
  const errors = [];

  function consider(job, source) {
    stats.found++;
    if (!job.url || !job.title) return;
    if (!titleFilter(job.title)) { stats.title++; return; }
    if (!locationFilter(job.location)) { stats.location++; return; }
    if (isStale(job.postedAt, maxAgeDays)) { stats.stale++; return; }
    const key = roleKey(job.company, job.title);
    if (seenUrls.has(job.url) || seenCompanyRoles.has(key)) { stats.dupes++; return; }
    // Mark as seen to avoid intra-scan dupes
    seenUrls.add(job.url);
    seenCompanyRoles.add(key);
    const label = job.via ? `${source}:${job.via}` : source;
    newOffers.push({ ...job, source: label });
    perSource[source] = (perSource[source] || 0) + 1;
  }

  const companyTasks = targets.map(company => async () => {
    try {
      const jobs = await fetchCompany(company, company._api, opts);
      for (const job of jobs) consider(job, `${company._api.type}-api`);
    } catch (err) {
      errors.push({ name: company.name, error: err.message });
    }
  });

  const queryTasks = searchTasks.map(t => async () => {
    try {
      const jobs = t.parse(await fetchJson(t.url, t.init));
      for (const job of jobs) consider(job, t.source);
    } catch (err) {
      errors.push({ name: `${t.source} "${t.query}"`, error: err.message });
    }
  });

  await parallelFetch([...companyTasks, ...queryTasks], CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Searches run:          ${searchTasks.length}`);
  console.log(`Total jobs found:      ${stats.found}`);
  console.log(`Filtered by title:     ${stats.title} removed`);
  if (config.location_filter) console.log(`Filtered by location:  ${stats.location} removed`);
  if (maxAgeDays) console.log(`Older than ${maxAgeDays} days:    ${stats.stale} removed`);
  console.log(`Duplicates:            ${stats.dupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  const bySource = Object.entries(perSource).map(([s, n]) => `${s} ${n}`).join(', ');
  if (bySource) console.log(`  by source:           ${bySource}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.name}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    newOffers.sort((a, b) => a.company.localeCompare(b.company));
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Run only when executed directly, so tests can import the helpers
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
