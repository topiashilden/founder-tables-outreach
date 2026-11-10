// LinkedIn Member Data Portability API (EU DMA), Member Snapshot, the CONNECTIONS domain only: a member's
// first-degree connections, the same people as LinkedIn's Connections.csv. Ported from warm-paths (lib/linkedin-dma.ts).
//
// The token is the member's own: a self-serve token (scope r_dma_portability_self_serve), or, on a platform, one the
// member granted it (scope r_dma_portability_3rd_party). It is never printed, logged
// or stored by this module, and nothing but CONNECTIONS is fetched. Emails are dropped before anything is written.
// It runs on a server or on the member's machine: LinkedIn's API cannot be called from a browser page (no CORS,
// and the token must stay private). The output is a Connections.csv without emails, which the widget reads as is.
// Docs: https://learn.microsoft.com/linkedin/dma/member-data-portability/shared/member-snapshot-api
// How to get a token: docs/linkedin-data.md

export const DMA_URL = 'https://api.linkedin.com/rest/memberSnapshotData';
/** The only version this endpoint accepts; any other fails with 426 NONEXISTENT_VERSION. */
export const DMA_VERSION = '202312';
const MAX_TRIES = 6;

export class DmaError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Seconds or an HTTP date, as in Retry-After. */
function retryAfterMs(v) {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(120000, Math.max(0, s * 1000));
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.min(120000, Math.max(0, t - Date.now()));
}
const brief = (body) => body.replace(/\s+/g, ' ').slice(0, 200);

/**
 * Every page of the member's CONNECTIONS snapshot. `start` counts pages (0, 1, 2, ...); LinkedIn says there is no
 * more data with "No data found for this memberId", and its `total` is not reliable, so the loop runs until that
 * answer. 429 and 5xx are retried with Retry-After or a growing pause; 401 stops at once.
 */
export async function fetchConnections({ token, fetch: get = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPages = 5000, onPage } = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'Linkedin-Version': DMA_VERSION };
  const rows = [];
  let retries = 0, pages = 0;
  for (let start = 0; start < maxPages; start++) {
    const url = `${DMA_URL}?q=criteria&domain=CONNECTIONS&start=${start}`;
    let res, body;
    for (let attempt = 1; ; attempt++) {
      res = await get(url, { headers });
      body = await res.text();
      if (res.status !== 429 && res.status < 500) break;
      if (attempt >= MAX_TRIES) throw new DmaError(`LinkedIn kept answering ${res.status} on page ${start + 1}; stopped after ${attempt} tries. Try again later.`, res.status);
      retries++;
      await sleep(retryAfterMs(res.headers.get('retry-after')) ?? Math.min(60000, 2000 * 2 ** (attempt - 1)));
    }
    if (res.status === 200) {
      let page;
      try { page = JSON.parse(body); } catch { throw new DmaError(`LinkedIn's answer on page ${start + 1} was not JSON: ${brief(body)}`, 200); }
      const data = (page.elements ?? []).filter((e) => !e.snapshotDomain || e.snapshotDomain === 'CONNECTIONS').flatMap((e) => e.snapshotData ?? []);
      rows.push(...data);
      pages++;
      onPage?.(pages, data.length);
      // An empty page with no next link is the end too; never loop forever.
      if (!data.length && !page.paging?.links?.some((l) => l.rel === 'next')) break;
      await sleep(250);
      continue;
    }
    if (res.status === 404 && /no data found/i.test(body)) {
      if (start === 0) throw new DmaError('LinkedIn has no CONNECTIONS snapshot for this member yet. It builds the snapshot after the token is created, which can take a while; try again later.', 404);
      break;
    }
    if (res.status === 401) throw new DmaError('LinkedIn rejected the token (401): it has expired or been revoked. Create a new one with LinkedIn\'s OAuth Token Generator (scope r_dma_portability_self_serve). See docs/linkedin-data.md.', 401);
    if (res.status === 403) throw new DmaError('LinkedIn refused access (403). The token\'s app needs a Member Data Portability API product (Member, scope r_dma_portability_self_serve, for your own data; 3rd Party, scope r_dma_portability_3rd_party, for a platform), and the member must be in the EEA or Switzerland.', 403);
    if (res.status === 426) throw new DmaError(`LinkedIn refused the API version (426): this endpoint only accepts Linkedin-Version ${DMA_VERSION}.`, 426);
    throw new DmaError(`LinkedIn answered ${res.status} on page ${start + 1}: ${brief(body)}`, res.status);
  }
  return { rows, pages, retries };
}

// ---------- rows -> the Connections.csv model ----------

// Keys as LinkedIn's CSV names them, plus spellings an API might use; compared folded.
const ALIASES = {
  first: ['first name', 'firstname'],
  last: ['last name', 'lastname'],
  url: ['url', 'profile url', 'profileurl', 'public profile url'],
  company: ['company', 'company name', 'companyname'],
  position: ['position', 'title', 'job title'],
  connectedOn: ['connected on', 'connectedon', 'connection date', 'connectedat'],
  email: ['email address', 'email', 'emailaddress'],
};
const foldKey = (k) => k.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const KEY_OF = new Map(Object.entries(ALIASES).flatMap(([field, names]) => names.map((n) => [foldKey(n), field])));
const text = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : String(v).trim());
const dateText = (v) => (typeof v === 'number' && v > 1e11 ? new Date(v).toISOString().slice(0, 10) : text(v));

/** https://www.linkedin.com/in/<Some-Name>/?x=1 -> linkedin.com/in/<some-name> (the only key people merge by) */
export function profileKey(url) {
  const m = (url || '').trim().toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
  if (!m) return '';
  try { return 'linkedin.com/in/' + decodeURIComponent(m[1]); } catch { return 'linkedin.com/in/' + m[1]; }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ymd = (y, m, d) => { const dt = new Date(Date.UTC(y, m, d)); return dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : ''; };
/** ISO dates and LinkedIn's "12 Apr 2026" -> YYYY-MM-DD, or "". */
export function isoDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})\w*[\s-]+(\d{4}|\d{2})$/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return '';
}

/**
 * LinkedIn's pages overlap: each can hold most of the same people again, so concatenated pages count people two or
 * three times. People are kept once, by profile URL (the same key the network merges by), with the row from the
 * latest page. A row without a profile URL is a repeat only when every field is identical; a name never merges.
 */
export function toConnections(rows) {
  const other = new Set();
  const people = new Map();
  for (const r of rows) {
    const c = { first: '', last: '', url: '', company: '', position: '', connectedOn: '' };
    let email = false;
    for (const [k, v] of Object.entries(r)) {
      const field = KEY_OF.get(foldKey(k));
      if (!field) { other.add(k); continue; }
      if (field === 'email') { if (text(v)) email = true; continue; }
      if (!c[field]) c[field] = field === 'connectedOn' ? dateText(v) : text(v);
    }
    const key = profileKey(c.url) || `row:${JSON.stringify(c)}`;
    people.set(key, { c, email: email || !!people.get(key)?.email });
  }
  const connections = [...people.values()].map((p) => p.c);
  const cov = { rows: connections.length, fetched: rows.length, repeats: rows.length - connections.length, first: 0, last: 0, url: 0, profileUrl: 0, company: 0, position: 0, connectedOn: 0, connectedOnDates: 0, emailsDropped: 0, otherKeys: [...other].sort() };
  for (const { c, email } of people.values()) {
    for (const f of ['first', 'last', 'url', 'company', 'position', 'connectedOn']) if (c[f]) cov[f]++;
    if (/linkedin\.com\/in\//i.test(c.url)) cov.profileUrl++;
    if (isoDate(c.connectedOn)) cov.connectedOnDates++;
    if (email) cov.emailsDropped++;
  }
  return { connections, coverage: cov };
}

const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** The same columns as LinkedIn's Connections.csv, without the email. The widget's "Attach" button reads this file. */
export function toCsv(connections) {
  return ['First Name,Last Name,URL,Company,Position,Connected On', ...connections.map((c) => [c.first, c.last, c.url, c.company, c.position, c.connectedOn].map(csvCell).join(','))].join('\n') + '\n';
}

const pct = (n, of) => (of ? `${Math.round((1000 * n) / of) / 10}%` : '-');
/** Counts only, never a name or a value. */
export function coverageLines(c) {
  const row = (label, n, note = '') => `  ${label.padEnd(14)} ${n.toLocaleString('en-US').padStart(7)}  ${pct(n, c.rows).padStart(6)}${note}`;
  return [
    ...(c.repeats ? [`${c.fetched.toLocaleString('en-US')} rows came back; ${c.repeats.toLocaleString('en-US')} repeated people already on an earlier page and are kept once.`] : []),
    `${c.rows.toLocaleString('en-US')} connections. Fields with a value:`,
    row('First Name', c.first),
    row('Last Name', c.last),
    row('URL', c.url, c.url !== c.profileUrl ? `  (${c.profileUrl.toLocaleString('en-US')} are linkedin.com/in/ profile URLs)` : ''),
    row('Company', c.company),
    row('Position', c.position),
    row('Connected On', c.connectedOn, c.connectedOn !== c.connectedOnDates ? `  (${c.connectedOnDates.toLocaleString('en-US')} read as dates)` : ''),
    `  Emails: ${c.emailsDropped ? `${c.emailsDropped.toLocaleString('en-US')} rows had one; dropped, never stored` : 'none came back'}.`,
    `  Other keys: ${c.otherKeys.length ? c.otherKeys.join(', ') : 'none'}.`,
    ...(c.profileUrl < c.rows ? [`  Without a profile URL, ${(c.rows - c.profileUrl).toLocaleString('en-US')} people cannot merge with a teammate's network: they stay separate.`] : []),
  ];
}
