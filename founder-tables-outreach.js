/*
 * <founder-tables-outreach>: find guests in your LinkedIn network and invite them, from inside a host platform.
 *
 * One file, no dependencies, no build. Drop it on any page:
 *   <script src="founder-tables-outreach.js" defer></script>
 *   <founder-tables-outreach></founder-tables-outreach>
 *   el.config = { ... }   // see README.md
 *
 * Product rules (carried over from warm-paths; do not break these):
 *  - Connections.csv is read in the browser only. The Email column is never read or stored.
 *  - People merge by LinkedIn profile URL only. A name alone never merges two people.
 *  - Ranking and fit are deterministic code. Nothing is guessed, nothing is invented.
 *  - Nothing is sent by this widget. "Send" copies the message and opens the person on LinkedIn;
 *    the human presses send and then confirms here, so the tracker only records what happened.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FounderTablesOutreach = api;
  if (typeof customElements !== 'undefined' && typeof HTMLElement !== 'undefined') api.define();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ───────────────────────── core: pure functions (tested in test.mjs) ─────────────────────────

  const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const SUFFIXES = /\b(oyj|oy|ab|abp|ky|ay|tmi|ltd|limited|inc|gmbh|llc|as|a\/s|aps|plc|co|corp|corporation|group|osakeyhtio|aktiebolag)\b\.?/g;
  /** "Rautio Industrial Oy" and "rautio industrial" give the same key. */
  const companyKey = (name) => {
    const f = fold(name).replace(/[^a-z0-9]+/g, ' ').trim();
    return f.replace(SUFFIXES, ' ').replace(/[^a-z0-9]+/g, ' ').trim() || f;
  };
  /** https://www.linkedin.com/in/<Some-Name>/?x=1 -> linkedin.com/in/<some-name> */
  const profileKey = (url) => {
    const m = (url || '').trim().toLowerCase().match(/^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^/?#]+)/);
    if (!m) return '';
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch { /* keep as is */ }
    return 'linkedin.com/in/' + slug;
  };
  /** A URL that is safe to put in href: LinkedIn profiles only. */
  const safeProfileUrl = (url) => (profileKey(url) ? url.trim() : '');

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // --- CSV ---
  function splitCsv(text, delim) {
    const rows = [];
    let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  const headerName = (h) => (h || '').replace(/^﻿/, '').trim().replace(/^"|"$/g, '').trim().toLowerCase();
  const COLUMNS = {
    first: ['first name'], last: ['last name'], url: ['url', 'profile url', 'linkedin url'],
    company: ['company'], position: ['position', 'title'],
  };
  const MAX_ROWS = 50000;

  /**
   * LinkedIn's Connections.csv -> { rows, report }. Tolerates a BOM, Windows line ends, the "Notes:" preamble
   * or none, reordered columns, and a semicolon re-save. The Email Address column is never read.
   */
  function parseConnections(text) {
    const report = { rows: 0, accepted: 0, skipped: 0, warnings: [], error: '' };
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const start = lines.slice(0, 50).findIndex((l) => {
      const cells = l.split(/[,;\t]/).map(headerName);
      return cells.includes('first name') && cells.includes('last name');
    });
    if (start < 0) {
      report.error = "This doesn't look like LinkedIn's Connections.csv (no First Name / Last Name header).";
      return { rows: [], report };
    }
    const hl = lines[start];
    const delim = [',', ';', '\t'].map((d) => [d, hl.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const table = splitCsv(lines.slice(start).join('\n'), delim);
    const head = table[0].map(headerName);
    const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
    if (at.url < 0) report.warnings.push('No URL column (an older export?). These people cannot be merged across networks, and cannot be opened on LinkedIn.');
    if (at.company < 0 || at.position < 0) report.warnings.push('No Company or Position column, so matching on titles and companies will find little.');
    const rows = [];
    let noUrl = 0;
    for (const r of table.slice(1)) {
      if (!r.some((x) => x.trim())) continue;
      report.rows++;
      const get = (k) => (at[k] >= 0 ? (r[at[k]] || '').trim() : '');
      const first = get('first'), last = get('last');
      if (!first && !last) { report.skipped++; continue; }
      const url = get('url');
      if (!profileKey(url)) noUrl++;
      rows.push({ first, last, url, company: get('company'), position: get('position') });
      if (rows.length >= MAX_ROWS) { report.warnings.push(`Stopped at ${MAX_ROWS} connections.`); break; }
    }
    if (report.skipped) report.warnings.push(`${report.skipped} rows have no name and were skipped.`);
    if (noUrl && at.url >= 0) report.warnings.push(`${noUrl} connections have no profile URL: they stay separate and cannot be opened on LinkedIn.`);
    report.accepted = rows.length;
    return { rows, report };
  }

  // --- people ---
  /** Networks -> people. Merged by profile URL only; rows without a URL stay separate. */
  function mergePeople(networks) {
    const map = new Map();
    for (const n of networks) {
      n.rows.forEach((r, i) => {
        const pk = profileKey(r.url);
        const key = pk || (n.sample && r.url) || `${n.id}:${i}`; // samples merge on an explicit key; real people on profile URL only
        let p = map.get(key);
        if (!p) { p = { key, first: r.first, last: r.last, url: safeProfileUrl(r.url), company: r.company || '', position: r.position || '', owners: [], sample: !!n.sample }; map.set(key, p); }
        if (!p.owners.includes(n)) p.owners.push(n);
        if (!n.sample) p.sample = false;
      });
    }
    return [...map.values()];
  }

  const SENIOR = /\b(head|director|vp|vice president|chief|cto|cmo|coo|ceo|cfo|partner|founder|professor|lead|manager)\b/i;
  // Never a decision-maker: students, trainees, assistants, board years, event organisers.
  const NEVER_ROLE = /\b(student|intern|trainee|assistant|opiskelija|harjoittelija|praktikant|head of events)\b|\bboard\s+20\d\d\b/i;

  const asRe = (x) => (!x ? null : x instanceof RegExp ? new RegExp(x.source, x.flags.includes('i') ? x.flags : x.flags + 'i') : new RegExp(String(x), 'iu'));

  /** A topic from the host config, ready to match. Bad regexes are dropped, not thrown. */
  function compileTopic(t) {
    let title = null, org = null;
    try { title = asRe(t.match && t.match.title); } catch { /* ignore */ }
    try { org = asRe(t.match && t.match.org); } catch { /* ignore */ }
    const req = ['title', 'org', 'any', 'both'].includes(t.match && t.match.req) ? t.match.req : 'any';
    return {
      key: String(t.key), label: t.label || t.key, topic: t.topic || t.label || t.key,
      why: t.why || 'fits what the table needs', rule: { title, org, req }, keywords: t.keywords || [], default: !!t.default, plain: !!t.plain,
      founders: (t.founders || []).map((f) => (typeof f === 'string' ? { name: f, group: '' } : { name: f.name, group: f.group || '' })),
    };
  }

  /** A topic the user defines in the widget: comma-separated title and company keywords. */
  function customTopic({ title = '', org = '', label = 'Something else', topic = '' }) {
    const terms = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const re = (list) => (list.length ? new RegExp('(?<![\\p{L}])(?:' + list.map(escapeRe).join('|') + ')', 'iu') : null);
    return {
      key: 'custom', label, topic: topic || 'a topic you know well', why: 'fits what you are looking for',
      rule: { title: re(terms(title)), org: re(terms(org)), req: 'any' }, founders: [], custom: true,
    };
  }

  // --- the prompt: "make me a dinner in oslo for sustainable industry people" ---
  const EVENT_WORDS = ['dinner', 'lunch', 'breakfast', 'roundtable', 'workshop', 'meetup', 'evening', 'event'];
  // Words that say what kind of ask this is, not what the theme is.
  const STOP = new Set(('a an the me my us make plan create organise organize arrange host set up some small for with in on at of and or to about around ' +
    'people folks founders founder leaders experts guests professionals who that dinner lunch breakfast roundtable workshop meetup evening event ' +
    'sustainable sustainability green climate impact next week month please field sector space').split(' '));
  // --- the other kind of prompt: "find a CTO with battery experience for a portfolio company" ---
  // A search for people (a hire, an investor, an advisor, an intro), not guests. No event word means this kind.
  const FIND_ASK = /\b(find|hire|hiring|recruit\w*|looking for|search(?:ing)? for|who knows|intro(?:duce|duction)? to|talent|candidates?)\b/i;
  // ask: how a prompt says the role; title: words in a job title that mean it; org: company words that also count (a fund)
  const ROLES = [
    { label: 'CTO', ask: /\bcto\b|chief technology|technical co-?founder|head of engineering|vp (?:of )?engineering/i, title: ['cto', 'chief technology', 'technical co-founder', 'head of engineering', 'vp engineering', 'vp of engineering'] },
    { label: 'CEO', ask: /\bceo\b|chief executive|managing director/i, title: ['ceo', 'chief executive', 'managing director'] },
    { label: 'CFO', ask: /\bcfo\b|chief financial|head of finance|finance director/i, title: ['cfo', 'chief financial', 'head of finance', 'finance director'] },
    { label: 'COO', ask: /\bcoo\b|chief operating|head of operations/i, title: ['coo', 'chief operating', 'head of operations', 'operations director'] },
    { label: 'head of sales', ask: /\bsales\b|business development|chief revenue|\bcro\b/i, title: ['sales', 'business development', 'chief revenue', 'commercial'] },
    { label: 'marketing lead', ask: /\bcmo\b|marketing|head of growth/i, title: ['cmo', 'marketing', 'growth', 'brand'] },
    { label: 'product lead', ask: /\bcpo\b|product (?:manager|lead|owner)|head of product/i, title: ['cpo', 'product manager', 'product lead', 'head of product', 'product owner'] },
    { label: 'engineer', ask: /\bengineers?\b|\bdevelopers?\b/i, title: ['engineer', 'developer'] },
    { label: 'designer', ask: /\bdesigners?\b/i, title: ['designer', 'design lead'] },
    { label: 'scientist', ask: /\bscientists?\b|\bresearchers?\b|\bphd\b/i, title: ['scientist', 'researcher', 'research', 'r&d', 'professor'] },
    { label: 'investor', ask: /\binvestors?\b|\bvcs?\b|\bangels?\b/i, title: ['partner', 'investor', 'investment', 'principal', 'angel'], org: ['capital', 'ventures', 'fund', 'invest'], field: 'in' },
    { label: 'founder', ask: /\b(?:co-?)?founders?\b/i, title: ['founder', 'co-founder'], field: 'in' },
    { label: 'advisor', ask: /\badvis[oe]rs?\b|\bboard members?\b|\bmentors?\b/i, title: ['advisor', 'adviser', 'board', 'chair'] },
  ];
  // Words that say what kind of search it is, not which field.
  const FIND_FILLER = new Set(('find hire hiring recruit recruiting looking search searching who knows know intro introduce introduction talent candidate candidates ' +
    'someone somebody person experience experienced background from our portfolio company companies startup startups scaleup role job good great strong senior ' +
    'head lead need needs want hands attending attend going event').split(' '));
  const GENERIC = new Set(['sustainable', 'sustainability', 'green', 'climate', 'impact']);
  const article = (w) => (/^[A-Z]{2,}/.test(w) ? 'a' : /^[aeiou]/i.test(w) ? 'an' : 'a');
  const titleCase = (s) => s.replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  const words = (s) => (s.toLowerCase().match(/\p{L}[\p{L}]*/gu) || []);
  const sameStem = (a, b) => (a.length < 4 || b.length < 4 ? a === b : a.slice(0, 6) === b.slice(0, 6));

  /**
   * Plain-rules reading of a prompt: event word, place, date and theme, and which configured topic the theme
   * names (or keywords for a custom search). No model involved, so the same prompt always gives the same plan.
   * A host can replace this with its own `config.interpret`, e.g. one that asks Claude.
   */
  function interpretPrompt(prompt, topics = [], events = []) {
    const text = String(prompt || '').trim();
    const out = { mode: 'event', eventWord: 'dinner', place: '', date: '', theme: '', topicKey: '', custom: null, field: null, understood: [] };
    if (!text) return out;
    const lower = text.toLowerCase();
    out.eventWord = EVENT_WORDS.find((w) => new RegExp('\\b' + w + 's?\\b').test(lower)) || 'dinner';
    if (new RegExp('\\bfounder\\s+' + out.eventWord + '\\b').test(lower)) out.eventWord = 'founder ' + out.eventWord;

    const place = text.match(/\bin\s+([\p{L}][\p{L}\-]*(?:\s+[\p{L}][\p{L}\-]*)?)(?=\s+(?:for|with|on|about|around|of|to|that|who|people|founders|next)\b|[,.;]|$)/iu);
    if (place && (geocode(place[1]) || /^\p{Lu}/u.test(place[1].trim()))) out.place = titleCase(place[1].trim());
    const date = text.match(/\bon\s+((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+[a-z]{3,9})?|\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+[a-z]{3,9})/i);
    if (date) out.date = date[1].replace(/^\w/, (c) => c.toUpperCase());

    // an event named in the prompt ("stockholm's founder summit"): its city and dates come with it
    const f = fold(text);
    const ev = events.find((e) => f.includes(fold(e.name))) || events.find((e) => f.includes(fold(e.city)) && words(e.name).some((w) => w.length >= 5 && !STOP.has(w) && f.includes(w)));
    if (ev) { out.eventId = ev.id; out.place = ev.city; }
    const evWords = new Set(ev ? words(ev.name + ' ' + ev.city) : []);

    // A search for people, not guests: a role and/or a field, and who it is for
    const roles = ROLES.filter((r) => r.ask.test(text));
    const hasEventWord = EVENT_WORDS.some((w) => new RegExp('\\b' + w + 's?\\b').test(lower));
    if (!hasEventWord && (FIND_ASK.test(text) || roles.length)) {
      out.mode = 'find'; out.eventWord = '';
      const roleWords = new Set(roles.flatMap((r) => words(text.match(r.ask)[0])));
      const forM = text.match(/\bfor\s+(?:a|an|our|my)\s+([\p{L}\s-]*?(?:startup|company|scaleup|team))\b/iu);
      if (ev && !(place && fold(place[1]) === fold(ev.city))) out.place = '';   // the event's city is where it is, not where the person must be
      const drop = new Set(words([out.place, out.date, forM ? forM[1] : ''].join(' ')));
      const keep = (w) => !roleWords.has(w) && !drop.has(w) && !evWords.has(w) && !FIND_FILLER.has(w) && w.length > 1;
      let tokens = words(lower).filter((w) => keep(w) && !STOP.has(w));
      if (!tokens.length) tokens = words(lower).filter((w) => keep(w) && GENERIC.has(w));   // "climate" is generic, but it is the only field named
      const field = tokens.join(' ');
      const terms = new Set(tokens.map((w) => (w.length > 6 ? w.slice(0, 6) : w)));
      for (const t of topics) if (tokens.some((w) => (t.keywords || []).some((x) => words(String(x)).some((v) => sameStem(w, v))))) for (const k of t.keywords || []) terms.add(k.toLowerCase());
      const forWhom = /\bportfolio\b/i.test(text) ? 'one of our portfolio companies' : forM ? `${article(forM[1].trim())} ${forM[1].trim().toLowerCase()}` : '';
      const role = roles[0] || null;
      out.theme = field;
      out.find = {
        role: role ? role.label : '', fieldIn: role && role.field === 'in', field, forWhom,
        title: [...new Set(roles.flatMap((r) => r.title))], org: [...new Set(roles.flatMap((r) => r.org || []))], fieldTerms: [...terms], boost: [...new Set(tokens.map((w) => (w.length > 6 ? w.slice(0, 6) : w)))],
        label: [role ? role.label.replace(/^\w/, (c) => c.toUpperCase()) : 'People', field].filter(Boolean).join(' · '),
      };
      if (role || field) { out.topicKey = 'find'; out.understood = [out.find.label]; }
      return out;
    }

    // "an energy field founder dinner": the words before it name the field the founders work in
    const pre = text.match(/\b(?:an?|the)\s+([\p{L}][\p{L}\s-]*?)\s+founder\s+(?:dinner|lunch|breakfast|roundtable|workshop|meetup|evening|event)s?\b/iu);

    const forTheme = text.match(/\b(?:for|about|around)\s+(.+?)(?=\s+(?:people|folks|founders|leaders|experts|guests|professionals|in|on|with|next)\b|[,.;]|$)/i);
    let theme = pre ? pre[1] : forTheme ? forTheme[1] : '';
    if (!theme) {
      const drop = [out.place, out.date].filter(Boolean).join(' ').toLowerCase();
      theme = words(lower).filter((w) => !STOP.has(w) && !drop.split(/\s+/).includes(w)).join(' ');
    }
    out.theme = theme.trim();

    // The theme's own words; generic ones ("sustainable") are dropped unless nothing else is left.
    // words that only name the event or its city are not a guest theme ("industry" in "Example Industry Summit")
    let tokens = words(out.theme).filter((w) => !STOP.has(w) && !evWords.has(w) && w.length > 1);
    if (!tokens.length && !ev) tokens = words(out.theme).filter((w) => !['for', 'the', 'and', 'of', 'a', 'an'].includes(w));
    let best = null, bestScore = 0;
    for (const t of topics) {
      const vocab = words([t.label, t.topic, ...(t.keywords || [])].join(' ')).filter((w) => !STOP.has(w));
      const hits = tokens.filter((w) => vocab.some((v) => sameStem(w, v)));
      if (hits.length > bestScore) { best = t; bestScore = hits.length; }
    }
    const dflt = topics.find((t) => t.default) || null;
    if (pre && dflt && tokens.length) {
      // founders in a field: the default topic's title rule, plus company keywords from the field's own words and from any topic those words name
      const terms = new Set(tokens);
      for (const t of topics) if (t !== dflt && tokens.some((w) => [t.label, t.topic, ...(t.keywords || [])].some((x) => words(String(x)).some((v) => sameStem(w, v))))) for (const k of t.keywords || []) terms.add(k.toLowerCase());
      out.field = { org: [...terms], label: out.theme.replace(/\s+(field|sector|space)$/i, '') };
      best = dflt; bestScore = 1;
    }
    if (!best && ev) { best = dflt; }   // an event and nothing else named: the topic marked default (e.g. founders)
    if (best) { out.topicKey = best.key; out.understood = [best.label]; }
    else if (tokens.length && !out.field) {
      const kw = tokens.map((w) => (w.length > 6 ? w.slice(0, 6) : w)).join(', ');
      out.topicKey = 'custom';
      out.custom = { title: kw, org: kw, topic: out.theme };
      out.understood = tokens;
    }
    return out;
  }

  /** The topic for a find-mode search (see interpretPrompt's `find`). */
  function findTopic(f) {
    const rx = (list) => (list && list.length ? new RegExp('(?<![\\p{L}])(?:' + list.map(escapeRe).join('|') + ')', 'iu') : null);
    const title = rx(f.title), field = rx(f.fieldTerms), fund = rx(f.org);
    // a fund counts as the field for investors: "investors in hydrogen" are partners at funds, whatever the fund is called
    const org = field && fund ? new RegExp(field.source + '|' + fund.source, 'iu') : field || fund;
    return {
      key: 'find', find: f, label: f.label, topic: f.label, why: 'fits what you are looking for', founders: [], plain: false, boost: rx(f.boost),
      rule: { title, org, req: title && org ? 'both' : title ? 'title' : 'any', titleOrg: field },   // the field may be in the title ("Battery engineer"); a fund only in the company
    };
  }

  /** The whole word around a match: "procure" in "Procurement" -> "Procurement". */
  function wordAround(s, m) {
    let a = m.index, b = m.index + m[0].length;
    while (a > 0 && /[\p{L}&]/u.test(s[a - 1])) a--;
    while (b < s.length && /[\p{L}&]/u.test(s[b])) b++;
    return s.slice(a, b);
  }

  /** How well a person fits a topic: null, or { strong, score, on, why }. `on` says what matched, in plain words. */
  function fitFor(p, topic) {
    const { title, org, req } = topic.rule;
    if (!p.position || NEVER_ROLE.test(p.position)) return null;
    const tm = title && p.position.match(title), om = org && (p.company.match(org) || (topic.rule.titleOrg && p.position.match(topic.rule.titleOrg)));
    const ok = { title: tm, org: om, any: tm || om, both: tm && om }[req];
    if (!ok) return null;
    const senior = SENIOR.test(p.position);
    const strong = !!((tm && om) || (tm && senior));
    const mine = p.owners.some((o) => o.me);
    const own = topic.boost && (topic.boost.test(p.company) || topic.boost.test(p.position));
    const score = (tm ? 2 : 0) + (om ? 2 : 0) + (senior ? 1 : 0) + (mine ? 0.5 : 0) + (own ? 1.5 : 0);
    const on = [tm && `title “${wordAround(p.position, tm).toLowerCase()}”`, om && `${om.input === p.company ? 'company' : 'title'} “${wordAround(om.input, om)}”`].filter(Boolean).join(', ');
    return { strong, score, on, why: topic.why };
  }

  // --- dates ---
  const DAY = 86400000;
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
  const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
  const shortDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  // --- what the team's statuses mean (one rule for every recommendation, as in warm-paths) ---
  /**
   * 'new'      never contacted (or a snooze that ended): may be recommended
   * 'waiting'  sent less than followUpDays ago: hidden
   * 'followup' sent followUpDays or more ago with no reply: shown under Outreach, never as a new recommendation
   * 'replied' | 'meeting' | 'not_fit': never recommended again
   * 'snoozed'  hidden until the snooze ends
   */
  function stateOf(rec, today, opts = {}) {
    const followUpDays = opts.followUpDays ?? 7;
    if (!rec) return 'new';
    if (rec.status === 'sent') return daysBetween(rec.at, today) >= followUpDays ? 'followup' : 'waiting';
    if (rec.status === 'snoozed') return rec.until && today < rec.until ? 'snoozed' : 'new';
    return rec.status; // replied, meeting, not_fit
  }

  /**
   * Candidates for a topic, best first, one person per company. Anyone already handled is left out;
   * when a colleague was contacted recently the others at that company rank lower and say so.
   */
  function rank(people, topic, ctx) {
    const { outreach = {}, today, followUpDays = 7, colleagueDays = 30, attending = null, eventName = '' } = ctx;
    const recent = new Map(); // companyKey -> latest contact date
    for (const rec of Object.values(outreach)) {
      if (!rec.ck || !['sent', 'replied', 'meeting'].includes(rec.status)) continue;
      if (daysBetween(rec.at, today) <= colleagueDays && (!recent.has(rec.ck) || rec.at > recent.get(rec.ck))) recent.set(rec.ck, rec.at);
    }
    const best = new Map();
    for (const p of people) {
      const f = fitFor(p, topic);
      if (!f) continue;
      if (stateOf(outreach[p.key], today, { followUpDays }) !== 'new') continue;
      const ck = companyKey(p.company);
      let score = f.score, note = '';
      if (attending && attending.has(p.key)) { score += 1.5; note = `Attending ${eventName || 'the event'}`; }
      if (ck && recent.has(ck)) { score -= 3; note += (note ? ' · ' : '') + `Colleague contacted ${shortDate(recent.get(ck))}`; }
      const slot = ck || p.key;
      const cur = best.get(slot);
      if (!cur || score > cur.score) best.set(slot, { p, f, score, note });
    }
    return [...best.values()].sort((a, b) => (b.f.strong - a.f.strong) || (b.score - a.score) || a.p.last.localeCompare(b.p.last));
  }

  /** Spread members over tables of ~size so each table mixes groups (the Founder Tables rule). */
  function seatTables(members, size = 6) {
    if (!members.length) return [[]];
    const nTables = Math.max(1, Math.round(members.length / size));
    const byGroup = {};
    members.forEach((c) => (byGroup[c.group || ''] ||= []).push(c));
    const order = [];
    const queues = Object.values(byGroup).sort((a, b) => b.length - a.length);
    while (queues.some((q) => q.length)) queues.forEach((q) => q.length && order.push(q.shift()));
    const tables = Array.from({ length: nTables }, () => []);
    order.forEach((c, i) => tables[i % nTables].push(c));
    return tables;
  }


  // --- events: who is attending, and who in your community knows them ---
  /**
   * An event's attendee/partner list against the networks. A person matches only by LinkedIn profile URL (a name never
   * merges two people). Companies match by normalised name, to show where someone in the community knows someone.
   */
  function matchEvent(event, people) {
    const byKey = new Map(people.map((p) => [p.key, p]));
    const byCo = new Map();
    for (const p of people) { const ck = companyKey(p.company); if (ck) { if (!byCo.has(ck)) byCo.set(ck, []); byCo.get(ck).push(p); } }
    const rows = (event.attendees || []).map((a) => {
      const key = profileKey(a.url);
      const person = key ? byKey.get(key) || null : null;
      const ck = companyKey(a.company);
      const colleagues = (ck ? byCo.get(ck) || [] : []).filter((p) => !person || p.key !== person.key);
      return { a, key, person, colleagues };
    });
    const known = rows.filter((r) => r.person);
    const companies = new Set(rows.filter((r) => r.person || r.colleagues.length).map((r) => companyKey(r.a.company)));
    return { rows, known, companies: companies.size, attendingKeys: new Set(known.map((r) => r.key)) };
  }
  const eventDates = (e) => {
    const f = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return e.end && e.end !== e.start ? `${f(e.start).replace(/ \w+$/, '')}–${f(e.end)}` : f(e.start);
  };
  const longDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });


  // --- attendee lists: the organiser's export, your platform's RSVPs, or a public speaker/partner list ---
  // Columns are matched loosely (First/Last or Name, LinkedIn URL, Company, Title, City, Type). Emails are never read.
  const ACOLS = {
    first: ['first name', 'firstname', 'given name'], last: ['last name', 'lastname', 'surname', 'family name'],
    name: ['name', 'full name', 'attendee', 'attendee name', 'speaker'],
    url: ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url', 'url', 'profile url', 'profile'],
    company: ['company', 'company name', 'organisation', 'organization', 'employer'],
    position: ['title', 'job title', 'position', 'role'],
    city: ['city', 'location', 'home city', 'based in'],
    kind: ['type', 'kind', 'ticket', 'ticket type', 'category', 'attendee type'],
  };
  const KINDS = ['speaker', 'partner', 'exhibitor', 'startup', 'investor', 'attendee'];
  function parseAttendees(text) {
    const report = { rows: 0, accepted: 0, withUrl: 0, warnings: [], error: '' };
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const isHead = (l) => { const c = l.split(/[,;\t]/).map(headerName); return (c.includes('first name') && c.includes('last name')) || ACOLS.name.some((n) => c.includes(n)); };
    const start = lines.slice(0, 30).findIndex(isHead);
    if (start < 0) { report.error = 'No header with First Name / Last Name or Name found. See docs/event-data.md for the columns.'; return { rows: [], report }; }
    const hl = lines[start];
    const delim = [',', ';', '\t'].map((d) => [d, hl.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const table = splitCsv(lines.slice(start).join('\n'), delim);
    const head = table[0].map(headerName);
    const at = Object.fromEntries(Object.entries(ACOLS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
    if (at.url < 0) report.warnings.push('No LinkedIn URL column: people cannot be matched to your networks, only their companies.');
    const rows = [];
    for (const r of table.slice(1)) {
      if (!r.some((x) => x.trim())) continue;
      report.rows++;
      const get = (k) => (at[k] >= 0 ? (r[at[k]] || '').trim() : '');
      let first = get('first'), last = get('last');
      if (!first && !last && get('name')) { const parts = get('name').split(/\s+/); first = parts.shift(); last = parts.join(' '); }
      if (!first && !last && !get('company')) continue;                   // partner pages list companies: kept for company-level matches
      const url = safeProfileUrl(get('url'));
      if (url) report.withUrl++;
      const k = fold(get('kind'));
      rows.push({ first, last, url, company: get('company'), position: get('position'), city: get('city'), kind: KINDS.find((x) => k.includes(x)) || 'attendee' });
    }
    report.accepted = rows.length;
    if (report.accepted && !report.withUrl && at.url >= 0) report.warnings.push('The LinkedIn URL column is empty: only company-level matches are possible.');
    return { rows, report };
  }

  // A small city lookup so events and attendees can be placed on the map without calling a geocoding service.
  // Unknown cities still match people; they are just not drawn.
  const CITY_LL = {
    stockholm: [59.33, 18.07], gothenburg: [57.71, 11.97], goteborg: [57.71, 11.97], malmo: [55.6, 13.0], uppsala: [59.86, 17.64], lund: [55.7, 13.19], linkoping: [58.41, 15.62], vasteras: [59.61, 16.55], umea: [63.83, 20.26], lulea: [65.58, 22.15],
    helsinki: [60.17, 24.94], espoo: [60.21, 24.66], tampere: [61.5, 23.76], turku: [60.45, 22.27], oulu: [65.01, 25.47],
    oslo: [59.91, 10.75], bergen: [60.39, 5.32], trondheim: [63.43, 10.4], stavanger: [58.97, 5.73],
    copenhagen: [55.68, 12.57], kobenhavn: [55.68, 12.57], aarhus: [56.16, 10.21], odense: [55.4, 10.39], reykjavik: [64.15, -21.94],
    tallinn: [59.44, 24.75], riga: [56.95, 24.11], vilnius: [54.69, 25.28], warsaw: [52.23, 21.01], krakow: [50.06, 19.94], gdansk: [54.35, 18.65], katowice: [50.26, 19.02], prague: [50.08, 14.44], vienna: [48.21, 16.37],
    berlin: [52.52, 13.4], hamburg: [53.55, 9.99], munich: [48.14, 11.58], frankfurt: [50.11, 8.68], dusseldorf: [51.23, 6.78], cologne: [50.94, 6.96],
    amsterdam: [52.37, 4.9], rotterdam: [51.92, 4.48], eindhoven: [51.44, 5.47], brussels: [50.85, 4.35], antwerp: [51.22, 4.4], zurich: [47.38, 8.54], geneva: [46.2, 6.14],
    london: [51.51, -0.13], cambridge: [52.21, 0.12], oxford: [51.75, -1.26], manchester: [53.48, -2.24], edinburgh: [55.95, -3.19], dublin: [53.35, -6.26], paris: [48.86, 2.35],
  };
  /** [lat, lon] for a city name ("Stockholm, Sweden" works), or null. */
  function geocode(city) {
    const k = fold(city || '').split(',')[0].replace(/[^a-z]+/g, '');
    return CITY_LL[k] || null;
  }

  // --- messages ---
  const MAX_CHARS = 500;
  // A message never says where a fact came from, and never mentions fit or scores.
  const NEVER_SAY = /matched on|\bscore\b|\bfit\b|our (?:analysis|data|algorithm)|algorithm|trade register|\bPRH\b/i;
  const list = (names) => (names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || '');

  /**
   * Message text from facts only. kind: 'direct' (your own connection), 'intro' (ask the person who knows them),
   * 'follow_up' (nudge; pass base 'direct' or 'intro').
   */
  function draft({ kind, base = 'direct', person, owner, table = [], topic, date, place, signature, eventWord = 'dinner', event = '' }) {
    const sig = signature && signature.trim() ? `\n\n${signature.trim()}` : '';
    const when = date && date.trim() ? ` on ${date.trim()}` : '';
    const where = place && place.trim() ? ` in ${place.trim()}` : '';
    const at = person.company ? ` at ${person.company}` : '';
    const names = table.slice(0, 3).map((c) => c.name);
    const group = table.length ? `${table.length} founders working on ${topic.topic}${names.length ? `, including ${list(names)}` : ''}` : `founders working on ${topic.topic}`;
    const during = event ? `, during ${event}` : '';
    const full = `${person.first} ${person.last}`.trim();
    if (kind === 'follow_up') {
      return base === 'intro'
        ? `Hi ${owner ? owner.name : 'there'},\n\nA quick nudge on my earlier note about an intro to ${full}${at}. No worries if it's not a fit.${sig}`
        : `Hi ${person.first},\n\nA quick nudge on my invite to the ${eventWord}${when}. Would you be able to join? No worries if not.${sig}`;
    }
    if (topic.find) {
      const f = topic.find, role = f.role ? `${article(f.role)} ${f.role}` : 'someone';
      const ask = `${role}${f.field ? (f.fieldIn ? ` in ${f.field}` : ` with ${f.field} experience`) : ''}${f.forWhom ? ` for ${f.forWhom}` : ''}${where}`;
      if (kind === 'follow_up') return base === 'intro'
        ? `Hi ${owner ? owner.name : 'there'},\n\nA quick nudge on my earlier note about an intro to ${full}${at}. No worries if it's not a fit.${sig}`
        : `Hi ${person.first},\n\nA quick nudge on my earlier note. Would you be open to a short chat? No worries if not.${sig}`;
      if (kind === 'intro') return `Hi ${owner ? owner.name : 'there'},\n\nCould you introduce me to ${full}${at}? I'm looking for ${ask}, and ${person.first} could be the right person, or know who is.\n\nHappy to write a short note you can forward.${sig}`;
      return `Hi ${person.first},\n\nI'm looking for ${ask}. With your work${at}, I thought you might be the right person, or know who is.\n\nWould you be open to a short chat?${sig}`;
    }
    if (topic.plain && kind === 'intro') return `Hi ${owner ? owner.name : 'there'},\n\nCould you introduce me to ${full}${at}? We're hosting a small ${eventWord}${where}${when}${during}, and ${person.first} would be a great guest.\n\nHappy to write a short note you can forward.${sig}`;
    if (topic.plain) return `Hi ${person.first},\n\nWe're hosting a small ${eventWord}${where}${when}${during}.\n\nWould you join us?${sig}`;
    if (kind === 'intro') {
      return `Hi ${owner ? owner.name : 'there'},\n\nCould you introduce me to ${full}${at}? We're seating ${group} at a small ${eventWord}${where}${when}, and ${person.first}'s view would help the table a lot.\n\nHappy to write a short note you can forward.${sig}`;
    }
    return `Hi ${person.first},\n\nWe're hosting a small ${eventWord}${where}${when}: ${group}.\n\nWith your work${at}, you'd bring the view the table is missing. Would you join us?${sig}`;
  }

  function voiceProblems(text) {
    const out = [];
    const m = text.match(NEVER_SAY);
    if (m) out.push(`Mentions “${m[0]}”: leave out how people were found.`);
    if (text.length > MAX_CHARS) out.push(`${text.length} characters; keep it under ${MAX_CHARS}.`);
    if (!text.trim()) out.push('The message is empty.');
    return out;
  }

  const emptyState = () => ({ v: 1, networks: [], settings: {}, outreach: {}, attendees: {} });

  /** What goes to storage: real networks as compact rows (no emails exist here to begin with), plus settings and statuses. */
  function serialize(state) {
    return {
      v: 1,
      networks: state.networks.filter((n) => !n.sample).map((n) => ({ id: n.id, name: n.name, role: n.role || '', me: !!n.me, url: n.url || '', rows: n.rows.map((r) => [r.first, r.last, r.url, r.company, r.position]) })),
      settings: state.settings,
      outreach: Object.fromEntries(Object.entries(state.outreach).map(([ev, recs]) => [ev, Object.fromEntries(Object.entries(recs).filter(([, r]) => !r.sample))])),
      attendees: state.attendees || {},
    };
  }
  function deserialize(data) {
    const s = emptyState();
    if (!data || data.v !== 1) return s;
    s.networks = (data.networks || []).map((n) => ({ id: n.id, name: n.name, role: n.role, me: !!n.me, url: n.url || '', rows: (n.rows || []).map(([first, last, url, company, position]) => ({ first, last, url, company, position })) }));
    s.settings = data.settings || {};
    s.outreach = data.outreach || {};
    s.attendees = data.attendees || {};
    return s;
  }

  const core = { findTopic, parseAttendees, geocode, matchEvent, eventDates, longDate, interpretPrompt, fold, companyKey, profileKey, safeProfileUrl, parseConnections, mergePeople, compileTopic, customTopic, fitFor, stateOf, rank, seatTables, draft, voiceProblems, daysBetween, addDays, shortDate, serialize, deserialize, emptyState, MAX_CHARS };

  // ───────────────────────── the element ─────────────────────────

  // Look: plain black and white, square corners, Helvetica Neue, solid white buttons. Everything is a CSS variable,
  // so a host overrides it from outside: founder-tables-outreach { --ft-bg: #fff; --ft-fg: #111; }
  const STYLE = `
:host { display: block; --ft-bg: #000; --ft-surface: #0d0d0d; --ft-fg: #fff; --ft-muted: #a6a6a6; --ft-line: #3b3b3b; --ft-strong: #fff;
  --ft-accent: #fff; --ft-on-accent: #000; --ft-soft: #171717; --ft-glow: var(--ft-accent); --ft-c1: #ffffff; --ft-c2: #9ca3af; --ft-c3: #d1d5db; --ft-c4: #6b7280; --ft-c5: #e5e7eb; --ft-danger: #ff8a80; --ft-radius: 0;
  --ft-font: "Helvetica Neue", Helvetica, Arial, sans-serif;
  background: var(--ft-bg); color: var(--ft-fg); font: 16px/1.5 var(--ft-font); padding: 28px clamp(16px, 4vw, 40px) 40px; }
:host([theme="light"]) { --ft-bg: #fff; --ft-surface: #fff; --ft-fg: #000; --ft-muted: #5c5c5c; --ft-line: #cfcfcf; --ft-strong: #000; --ft-accent: #000; --ft-on-accent: #fff; --ft-soft: #f2f2f2; --ft-danger: #b3261e; }
* { box-sizing: border-box; }
.ft { display: grid; gap: 28px; min-width: 0; max-width: 1080px; margin: 0 auto; }
h1, h2, h3 { margin: 0; line-height: 1.1; text-wrap: balance; font-weight: 700; }
h2 { font-size: clamp(1.9rem, 4.6vw, 3rem); letter-spacing: -0.02em; }
p { margin: 0; }
.eyebrow { font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--ft-muted); font-weight: 600; }
.muted { color: var(--ft-muted); }
.head { display: grid; gap: 12px; }
.lede { color: var(--ft-muted); font-size: 1.05rem; max-width: 60ch; }
button, input, select, textarea { font: inherit; color: inherit; border-radius: var(--ft-radius); }
.btn { appearance: none; cursor: pointer; border: 1px solid var(--ft-accent); background: var(--ft-accent); color: var(--ft-on-accent); font-weight: 600; font-size: 14px; padding: 9px 16px; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; line-height: 1.2; }
.btn.big { font-size: 16px; padding: 14px 26px; }
.btn.ghost { background: transparent; color: var(--ft-fg); border-color: var(--ft-line); }
.btn.ghost:hover { border-color: var(--ft-fg); }
.btn.quiet { background: transparent; color: var(--ft-muted); border-color: var(--ft-line); }
.btn.small { padding: 6px 11px; font-size: 12.5px; }
.btn:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 2px solid var(--ft-fg); outline-offset: 2px; }
/* prompt */
.prompt { display: grid; gap: 12px; }
.prompt-box { display: grid; grid-template-columns: 1fr auto; gap: 0; border: 1px solid var(--ft-fg); }
.prompt-box textarea { resize: none; background: transparent; border: 0; padding: 16px 18px; font-size: clamp(1.05rem, 2.4vw, 1.3rem); line-height: 1.35; min-height: 64px; width: 100%; }
.prompt-box textarea:focus-visible { outline: none; }
.prompt-box:focus-within { outline: 2px solid var(--ft-fg); outline-offset: 2px; }
.prompt-box .btn { border: 0; align-self: stretch; padding: 0 24px; font-size: 15px; }
@media (max-width: 560px) { .prompt-box { grid-template-columns: 1fr; } .prompt-box .btn { padding: 14px; justify-content: center; } }
.examples { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; color: var(--ft-muted); }
.plan { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tag { border: 1px solid var(--ft-line); padding: 4px 10px; font-size: 13px; }
.tag b { font-weight: 600; }
.steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0; border: 1px solid var(--ft-line); }
.step { padding: 14px 16px; display: grid; gap: 4px; font-size: 14px; border-right: 1px solid var(--ft-line); }
.step:last-child { border-right: 0; }
.step b { font-size: 15px; }
.privacy { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; color: var(--ft-muted); }
.privacy svg { flex: none; margin-top: 2px; color: var(--ft-fg); }
details.import, details.adjust { border: 1px solid var(--ft-line); }
details > summary { cursor: pointer; padding: 14px 16px; font-weight: 600; list-style-position: inside; }
.import-body, .adjust-body { padding: 0 16px 16px; display: grid; gap: 14px; }
.drop { border: 1px dashed var(--ft-line); padding: 14px; display: grid; gap: 12px; }
.drop.over { border-color: var(--ft-fg); background: var(--ft-soft); }
.row { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
.file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.field { display: grid; gap: 5px; font-size: 13px; color: var(--ft-muted); min-width: 0; }
.field input, .field select { font-size: 15px; font-weight: 500; color: var(--ft-fg); background: var(--ft-bg); border: 1px solid var(--ft-line); padding: 9px 12px; width: 100%; }
.check input { accent-color: var(--ft-fg); }
.check { display: inline-flex; gap: 8px; align-items: center; font-size: 13.5px; }
.nets { display: flex; flex-wrap: wrap; gap: 8px; }
.net { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--ft-line); padding: 4px 6px 4px 12px; font-size: 13px; }
.net .n { color: var(--ft-muted); font-variant-numeric: tabular-nums; }
.net button { appearance: none; border: 0; background: none; color: var(--ft-muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; }
.report { font-size: 12.5px; color: var(--ft-muted); }
.report.err { color: var(--ft-danger); }
.report ul { margin: 4px 0 0; padding-left: 18px; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--ft-line); }
.tab { appearance: none; border: 0; background: none; color: var(--ft-muted); font-weight: 600; font-size: 15px; padding: 10px 16px; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; display: inline-flex; gap: 8px; align-items: center; }
.tab[aria-selected="true"] { color: var(--ft-fg); border-bottom-color: var(--ft-fg); }
.count { font-size: 11px; padding: 1px 7px; background: var(--ft-line); color: var(--ft-fg); font-variant-numeric: tabular-nums; }
.count.due { background: var(--ft-accent); color: var(--ft-on-accent); }
.panel { display: grid; gap: 18px; }
.panel[hidden] { display: none; }
.controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; align-items: end; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px; }
.card { background: var(--ft-surface); border: 1px solid var(--ft-line); padding: 18px; display: grid; gap: 10px; align-content: start; min-width: 0; }
.card-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.card-head a { color: inherit; }
.badge { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; padding: 2px 7px; border: 1px solid var(--ft-fg); white-space: nowrap; }
.badge.strong { background: var(--ft-strong); color: var(--ft-on-accent); }
.badge.plain { border-color: var(--ft-line); color: var(--ft-muted); }
.badge.due { background: var(--ft-accent); color: var(--ft-on-accent); border-color: var(--ft-accent); }
.meta { font-size: 13px; color: var(--ft-muted); }
.draft { width: 100%; min-height: 176px; resize: vertical; background: var(--ft-bg); border: 1px solid var(--ft-line); padding: 10px 12px; font-size: 14px; line-height: 1.5; }
.draft-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--ft-muted); font-variant-numeric: tabular-nums; }
.problem { font-size: 12.5px; color: var(--ft-danger); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.confirm { display: grid; gap: 10px; background: var(--ft-soft); border: 1px solid var(--ft-line); padding: 12px; font-size: 14px; }
.more { display: grid; gap: 4px; }
.line { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; font-size: 14px; padding: 10px 0; border-top: 1px solid var(--ft-line); }
.line .grow { flex: 1; min-width: 160px; }
.empty { color: var(--ft-muted); font-size: 14px; padding: 6px 0; }
.banner { border-left: 2px solid var(--ft-fg); padding: 2px 0 2px 12px; font-size: 14px; }
.foot { font-size: 12.5px; color: var(--ft-muted); border-top: 1px solid var(--ft-line); padding-top: 16px; display: grid; gap: 4px; }
.toast { position: sticky; bottom: 12px; justify-self: center; background: var(--ft-fg); color: var(--ft-on-accent); padding: 8px 14px; font-size: 13.5px; }
.toast:empty { display: none; }
.link { appearance: none; background: none; border: 0; padding: 0; color: var(--ft-fg); cursor: pointer; text-decoration: underline; font-size: inherit; }
.netcv { display: block; width: 100%; aspect-ratio: 1000 / 560; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.term { border: 1px solid var(--ft-line); background: var(--ft-term, rgba(0,0,0,.45)); }
.term-bar { display: flex; gap: 6px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--ft-line); font: 12px ui-monospace, "SFMono-Regular", Menlo, monospace; color: var(--ft-muted); }
.term-bar i { width: 10px; height: 10px; border-radius: 50%; background: var(--ft-line); display: inline-block; }
.term-bar span { margin-left: 8px; }
.term-body { padding: 12px 14px; display: grid; gap: 3px; font: 13.5px/1.5 ui-monospace, "SFMono-Regular", Menlo, monospace; }
.tl { color: var(--ft-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.tl.cmd { color: var(--ft-fg); }
.tl.ok { color: var(--ft-fg); }
.tl.hot { color: var(--ft-glow, var(--ft-accent)); }
.tl.warn { color: var(--ft-danger); }
.tl.fresh { animation: tl-in calc(var(--n, 40) * 18ms) steps(var(--n, 40)) var(--d, 0s) both; }
@keyframes tl-in { from { clip-path: inset(0 100% 0 0); opacity: 1; } to { clip-path: inset(0 0 0 0); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .tl.fresh { animation: none; } }
.evchips { display: flex; flex-wrap: wrap; gap: 8px; }
.evchip { appearance: none; cursor: pointer; text-align: left; background: transparent; border: 1px solid var(--ft-line); padding: 10px 14px; display: grid; gap: 2px; font-size: 14px; }
.evchip span { font-size: 12.5px; }
.evchip[aria-pressed="true"] { border-color: var(--ft-fg); background: var(--ft-soft); }
.conn { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; border: 1px solid var(--ft-line); padding: 12px 16px; }
.connlist { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.cn { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
.cn .av { width: 24px; height: 24px; border-radius: 50%; background: var(--ft-fg); color: var(--ft-on-accent); display: grid; place-items: center; font-style: normal; font-weight: 700; font-size: 12px; }
.cn .n { color: var(--ft-muted); font-variant-numeric: tabular-nums; }
.connsum { margin-left: auto; font-size: 13px; }
.scopebar { display: grid; gap: 12px; }
.scopehead { font-size: 19px; }
.evsum { font-size: 16px; }
.simple #panel-map:not([hidden]), .simple #panel-event:not([hidden]) { animation: viewin .55s cubic-bezier(.2,.8,.2,1); }
.simple .card { animation: viewin .5s cubic-bezier(.2,.8,.2,1) both; }
.simple .card:nth-child(2) { animation-delay: .07s; } .simple .card:nth-child(3) { animation-delay: .14s; }
.simple .scopebar .seg .segb { transition: background .25s, color .25s; }
@keyframes viewin { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .simple .card, .simple #panel-map, .simple #panel-event { animation: none !important; } }
.simple .work { display: flex; flex-direction: column; gap: 18px; }
.simple #scopebar { order: 0; } .simple #panel-map { order: 1; } .simple #panel-event { order: 1; } .simple #panel-find { order: 2; }
.seg { display: inline-flex; border: 1px solid var(--ft-line); justify-self: start; }
.segb { appearance: none; cursor: pointer; background: transparent; border: 0; padding: 9px 16px; font-size: 14px; font-weight: 600; color: var(--ft-muted); }
.segb + .segb { border-left: 1px solid var(--ft-line); }
.segb[aria-pressed="true"] { background: var(--ft-fg); color: var(--ft-on-accent); }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag.hot { border-color: var(--ft-fg); }
.work[hidden], #import[hidden] { display: none; }
.work { display: grid; gap: 18px; }
/* map */
.map { border: 1px solid var(--ft-line); padding: 8px; overflow-x: auto; }
.map svg { display: block; width: 100%; min-width: 560px; height: auto; }
.map text { fill: var(--ft-fg); font-family: var(--ft-font); font-size: 12.5px; }
.map .sub { fill: var(--ft-muted); font-size: 11px; }
.map .edge { stroke: var(--ft-line); stroke-width: 1.2; fill: none; }
.map .edge.hot { stroke: var(--ft-fg); stroke-width: 1.8; }
.map .node { fill: var(--ft-bg); stroke: var(--ft-fg); stroke-width: 1.5; }
.map .node.strong { fill: var(--ft-fg); }
.insights { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0; border: 1px solid var(--ft-line); }
.insight { padding: 14px 16px; border-right: 1px solid var(--ft-line); display: grid; gap: 2px; align-content: start; }
.insight:last-child { border-right: 0; }
.insight b { font-size: 1.9rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
`;

  const SVG_LOCK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

  /** Small DOM builder. Text always goes in as text, never as HTML. */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'innerHTML' || k === 'value') e[k] = v;
      else if (k in e && k !== 'list' && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }

  const DEFAULTS = { id: 'default', title: 'Invite guests from your LinkedIn network', intro: '', date: '', place: '', signature: '', tableSize: 6, simple: false, followUpDays: 7, snoozeDays: 90, colleagueDays: 30, topics: [], sample: null };
  function normalizeConfig(c) {
    const cfg = { ...DEFAULTS, ...(c || {}) };
    cfg.topics = (cfg.topics || []).map(compileTopic);
    return cfg;
  }

  function countUp(el, to, ms) {
    if (!ms) { el.textContent = String(to); return; }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Draws the network and returns draw(t), t in seconds since the start.
   * Left: one cloud of dots per network (every connection). Right: the people who fit. Between them, strings that
   * grow out of the cloud, with a light travelling along each. A person known by two networks gets two strings.
   */
  function netPainter(host, { canvas, nets, shown, rel = null }) {
    const W = 1000, H = 560, ctx = canvas.getContext('2d');
    const cs = getComputedStyle(host);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const C = { fg: v('--ft-fg', '#fff'), muted: v('--ft-muted', '#a6a6a6'), bg: v('--ft-bg', '#000'),
      glow: v('--ft-glow', v('--ft-accent', '#fff')), font: cs.fontFamily || 'sans-serif',
      nets: [1, 2, 3, 4, 5].map((i) => v('--ft-c' + i, ['#ffffff', '#9ca3af', '#d1d5db', '#6b7280', '#e5e7eb'][i - 1])) };
    const hash = (str) => { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return ((x >>> 0) % 100000) / 100000; };
    const N = nets.length, ox = 262, rMax = Math.min(120, (H / (N + 1)) * 0.5);
    const oy = (i) => (H * (i + 1)) / (N + 1);
    const px = 640, py = (j) => (shown.length === 1 ? H / 2 : 44 + (j * (H - 88)) / (shown.length - 1));
    const col = (i) => C.nets[i % C.nets.length];
    const fitKeys = new Set(shown.map((r) => r.p.key));

    // clouds: every connection is a dot; the ones that fit are included first so they always have a place to start from
    const clouds = nets.map((n, i) => {
      const mine = n.rows.length ? shown.map((r) => r.p).filter((p) => p.owners.includes(n)) : [];
      const rest = [];
      const seen = new Set(mine.map((p) => p.key));
      n.rows.forEach((row, k) => { const key = profileKey(row.url) || (n.sample && row.url) || `${n.id}:${k}`; if (!seen.has(key)) { seen.add(key); rest.push(key); } });
      const keys = mine.map((p) => p.key).concat(rest).slice(0, 300);
      const pos = new Map();
      keys.forEach((key) => {
        const a = hash(key + '/a') * Math.PI * 2, r = Math.sqrt(0.06 + hash(key + '/r') * 0.94) * rMax;
        pos.set(key, { x: ox + Math.cos(a) * r, y: oy(i) + Math.sin(a) * r * 0.92, ph: hash(key + '/p') * 6.28, fit: fitKeys.has(key), d: hash(key + '/d') });
      });
      return { n, i, keys, pos };
    });

    // strings: one per (fit person, network that knows them)
    const edges = [];
    shown.forEach((r, j) => r.p.owners.forEach((o) => {
      const cl = clouds[nets.indexOf(o)];
      if (!cl || !cl.pos.has(r.p.key)) return;
      edges.push({ j, cl, key: r.p.key, shared: r.p.owners.length > 1, t0: 1.1 + j * 0.16 + hash(r.p.key + o.id) * 0.25, ph: hash(r.p.key + o.id + 'q') });
    }));
    const bez = (e, k, t) => {
      const a = e.cl.pos.get(e.key), sx = a.x + Math.sin(t * 0.5 + a.ph) * 2, sy = a.y + Math.cos(t * 0.45 + a.ph) * 2, ex = px, ey = py(e.j);
      const mx = sx + (ex - sx) * 0.55, u = 1 - k;
      return [u * u * u * sx + 3 * u * u * k * mx + 3 * u * k * k * (sx + (ex - sx) * 0.45) + k * k * k * ex,
              u * u * u * sy + 3 * u * u * k * sy + 3 * u * k * k * ey + k * k * k * ey];
    };
    const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    const ease = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
    const pop = (k) => { k = Math.min(1, Math.max(0, k)); return k < 1 ? 1 + 0.5 * Math.sin(k * Math.PI) * (1 - k) * 2 * k : 1; };

    // a dot with a soft halo made of a few translucent rings (cheap, no blur filter)
    const dot = (x, y, r, fill, alpha, halo, stroke) => {
      if (halo) for (const [k, a] of [[1, 0.1], [0.66, 0.1], [0.38, 0.12]]) { ctx.globalAlpha = alpha * a; ctx.fillStyle = C.glow; ctx.beginPath(); ctx.arc(x, y, r + halo * k, 0, 6.283); ctx.fill(); }
      ctx.globalAlpha = alpha; ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.6; ctx.stroke(); }
      ctx.globalAlpha = 1;
    };
    // a small outlined tag, text vertically centred on y
    const pill = (text, x, y, color) => {
      ctx.font = `600 10.5px ${C.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '0.8px';
      const w = ctx.measureText(text).width + 16, h = 19;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x, y - h / 2, w, h, h / 2); ctx.globalAlpha *= 0.35; ctx.stroke(); ctx.globalAlpha /= 0.35;
      ctx.textAlign = 'left'; ctx.fillText(text, x + 8, y + 0.5);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    };

    return function draw(t) {
      const w = canvas.clientWidth; if (!w) return;
      const dpr = Math.min(3, host.pixelRatio || (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round((w * H * dpr) / W); }
      const k = (w * dpr) / W;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'middle';

      // clouds
      for (const cl of clouds) {
        const base = ease((t - cl.i * 0.18) / 0.9);
        ctx.fillStyle = col(cl.i);
        for (const key of cl.keys) {
          const d = cl.pos.get(key), a = base * ease((t - 0.1 - d.d * 0.9) / 0.5);
          if (a <= 0) continue;
          ctx.globalAlpha = (d.fit ? 0.9 : 0.16 + d.d * 0.3) * a;
          ctx.beginPath(); ctx.arc(d.x + Math.sin(t * 0.5 + d.ph) * 2, d.y + Math.cos(t * 0.45 + d.ph) * 2, d.fit ? 2.6 : 1.5 + d.d * 0.9, 0, 6.283); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // strings (a soft wide pass under a sharp thin one: a glow without blur filters)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const e of edges) {
        const prog = ease((t - e.t0) / 1.0);
        if (prog <= 0) continue;
        const c = col(e.cl.i), path = new Path2D(), steps = Math.max(2, Math.ceil(48 * prog));
        for (let s2 = 0; s2 <= steps; s2++) { const [x, y] = bez(e, (s2 / steps) * prog, t); s2 ? path.lineTo(x, y) : path.moveTo(x, y); }
        ctx.strokeStyle = c;
        ctx.globalAlpha = e.shared ? 0.16 : 0.07; ctx.lineWidth = e.shared ? 7 : 4; ctx.stroke(path);
        ctx.globalAlpha = e.shared ? 0.95 : 0.5; ctx.lineWidth = e.shared ? 2 : 1.2; ctx.stroke(path);
        if (prog >= 1) { // a light travelling along the finished string
          const [x, y] = bez(e, (t * 0.32 + e.ph) % 1, t);
          dot(x, y, e.shared ? 2.8 : 2, e.shared ? C.fg : c, 1, e.shared ? 7 : 5);
        }
      }
      ctx.globalAlpha = 1;

      // the people who fit
      shown.forEach((r, j) => {
        const arrive = Math.min(...edges.filter((e) => e.j === j).map((e) => e.t0 + 0.95));
        const k2 = (t - arrive) / 0.5;
        if (!(k2 > 0)) return;
        const y = py(j), sh = r.p.owners.length > 1, a = Math.min(1, k2), radius = (sh ? 7 : 5.2) * pop(k2);
        if (sh) { // known by more than one of you: a slow pulse ring
          const ring = (t * 0.8) % 1;
          ctx.strokeStyle = C.glow; ctx.lineWidth = 1.5; ctx.globalAlpha = a * (1 - ring) * 0.8;
          ctx.beginPath(); ctx.arc(px, y, 8 + ring * 16, 0, 6.283); ctx.stroke();
        }
        dot(px, y, radius, r.f.strong || sh ? (sh ? C.glow : C.fg) : C.bg, a, sh ? 16 : 9, C.fg);
        ctx.globalAlpha = a;
        const nm = cut(`${r.p.first} ${r.p.last}`, 28);
        ctx.fillStyle = C.fg; ctx.font = `600 15px ${C.font}`; ctx.textAlign = 'left';
        ctx.fillText(nm, px + 20, y - 8);
        const nmW = ctx.measureText(nm).width;
        ctx.fillStyle = C.muted; ctx.font = `12.5px ${C.font}`;
        ctx.fillText(cut([r.p.position, r.p.company].filter(Boolean).join(' · '), 46), px + 20, y + 9);
        if (sh) pill('KNOWN BY ' + r.p.owners.map((o) => (o.me && o.name === 'Me' ? 'YOU' : o.name.toUpperCase())).join(' + '), px + 20 + nmW + 12, y - 8, C.glow);
        ctx.globalAlpha = 1;
      });

      // network nodes and labels
      for (const cl of clouds) {
        const a = ease((t - cl.i * 0.18) / 0.7), y = oy(cl.i), pulse = 0.5 + 0.5 * Math.sin(t * 1.6 + cl.i);
        dot(ox, y, 8, col(cl.i), a, 18 + pulse * 8);
        ctx.globalAlpha = a;
        ctx.textAlign = 'right'; ctx.fillStyle = C.fg; ctx.font = `700 17px ${C.font}`;
        const label = cl.n.me && cl.n.name === 'Me' ? 'You' : cl.n.name;
        ctx.fillText(cut(label, 14), ox - rMax - 18, y - 11);
        ctx.fillStyle = C.muted; ctx.font = `12.5px ${C.font}`;
        const rc = rel ? rel.get(cl.n) || 0 : null;   // this search's people in their network, not their whole network
        ctx.fillText(rc == null ? `${cl.n.rows.length} connections` : `${rc} relevant ${rc === 1 ? 'connection' : 'connections'}`, ox - rMax - 18, y + 8);
        if (cl.n.role) ctx.fillText(cut(cl.n.role, 22), ox - rMax - 18, y + 25);
        ctx.globalAlpha = 1;
      }
    };
  }

  /**
   * The event on a hexagon map of Europe, in white. Land is a hex grid over faint latitude/longitude lines; the view
   * zooms toward the event; every place attendees come from lights up as a hex, in a wave outward from the event; the
   * people your community knows burn bright with their name. No arcs: the network graph is the view with strings.
   * Nothing is invented: it draws the list it is given.
   */
  function eventPainter(host, { canvas, ev, evs, m, map }) {
    const W = map.w, H = map.h, ctx = canvas.getContext('2d'), rad = Math.PI / 180;
    const cs = getComputedStyle(host), v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const C = { fg: v('--ft-fg', '#fff'), muted: v('--ft-muted', '#a6a6a6'), bg: v('--ft-bg', '#000'), font: cs.fontFamily || 'sans-serif', mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace' };
    const P = (lon, lat) => {
      const l = (lon - map.lon0) * rad, ph = lat * rad, p0 = map.lat0 * rad;
      const k = Math.sqrt(2 / (1 + Math.sin(p0) * Math.sin(ph) + Math.cos(p0) * Math.cos(ph) * Math.cos(l)));
      return [(k * Math.cos(ph) * Math.sin(l) - map.minx) * map.R, (map.maxy - k * (Math.cos(p0) * Math.sin(ph) - Math.sin(p0) * Math.cos(ph) * Math.cos(l))) * map.R];
    };
    const ease = (k) => { k = Math.min(1, Math.max(0, k)); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
    const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

    // ---- hex grid (pointy-top), built once per map ----
    const S = 7.2, HW = Math.sqrt(3) * S;
    const centerOf = (q, r) => [HW * (q + r / 2), 1.5 * S * r];
    const hexAt = (x, y) => {
      const fq = ((Math.sqrt(3) / 3) * x - y / 3) / S, fr = ((2 / 3) * y) / S, fs = -fq - fr;
      let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
      const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
      if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
      return [q, r];
    };
    const hexTo = (p, cx, cy, s) => { for (let i = 0; i < 6; i++) { const a = rad * (60 * i - 30), x = cx + s * Math.cos(a), y = cy + s * Math.sin(a); i ? p.lineTo(x, y) : p.moveTo(x, y); } p.closePath(); };
    if (!map._hexPath) {
      const landPath = new Path2D(map.land), test = document.createElement('canvas').getContext('2d'), hp = new Path2D();
      for (let r = -1; 1.5 * S * r < H + S; r++) for (let q = -Math.ceil(r / 2) - 2; HW * (q + r / 2) < W + HW; q++) {
        const [x, y] = centerOf(q, r);
        if (x > -HW && y > -S && test.isPointInPath(landPath, x, y)) hexTo(hp, x, y, S * 0.9);
      }
      const gp = new Path2D();
      for (let lat = 40; lat <= 75; lat += 5) for (let lon = -25; lon <= 55; lon += 1) { const [x, y] = P(lon, lat); lon === -25 ? gp.moveTo(x, y) : gp.lineTo(x, y); }
      for (let lon = -20; lon <= 50; lon += 10) for (let lat = 36; lat <= 75; lat += 1) { const [x, y] = P(lon, lat); lat === 36 ? gp.moveTo(x, y) : gp.lineTo(x, y); }
      map._hexPath = hp; map._gratPath = gp; map._landPath = landPath;
    }

    // ---- where attendees come from, one hex per place ----
    const dest = P(ev.lon, ev.lat), [dq, dr] = hexAt(...dest), destC = centerOf(dq, dr);
    const cells = new Map();
    for (const r of m.rows) {
      if (r.a.lat == null) continue;
      const [q, rr] = hexAt(...P(r.a.lon, r.a.lat)), key = q + ',' + rr;
      if (q === dq && rr === dr) continue;
      const c = cells.get(key) || { c: centerOf(q, rr), n: 0, known: [] };
      c.n++; if (r.person) c.known.push(r); cells.set(key, c);
    }
    const cl = [...cells.values()].map((c) => ({ ...c, d: Math.hypot(c.c[0] - destC[0], c.c[1] - destC[1]) }));
    const maxD = Math.max(1, ...cl.map((c) => c.d));
    const knownCells = cl.filter((c) => c.known.length).sort((a, b) => b.known.length - a.known.length || a.d - b.d);

    // ---- the zoom: toward the event, leaning to where people come from ----
    let wx = 0, wy = 0, wn = 0;
    for (const c of cl) { wx += c.c[0] * c.n; wy += c.c[1] * c.n; wn += c.n; }
    const Z = 1.6;
    let tx = wn ? destC[0] * 0.6 + (wx / wn) * 0.4 : destC[0], ty = wn ? destC[1] * 0.6 + (wy / wn) * 0.4 : destC[1];
    tx = Math.min(W - W / Z / 2, Math.max(W / Z / 2, tx)); ty = Math.min(H - H / Z / 2, Math.max(H / Z / 2, ty));
    const view = (t) => { const e = ease((t - 0.3) / 1.9); return { z: 1 + (Z - 1) * e, cx: W / 2 + (tx - W / 2) * e, cy: H / 2 + (ty - H / 2) * e }; };
    const toScreen = (vw, x, y) => [(x - vw.cx) * vw.z + W / 2, (y - vw.cy) * vw.z + H / 2];

    // labels for the people the community knows, placed once so they never overlap (in final-view coordinates)
    const fin = view(99), rects = [], hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    const [fdx, fdy] = toScreen(fin, ...destC);
    rects.push([fdx - 14, fdy - 44, fdx + 240, fdy + 6], [0, 0, 330, 74], [W - 190, 0, W, 150], [0, H - 34, 420, H]);
    for (const c of knownCells.slice(0, 8)) {
      const [x, y] = toScreen(fin, ...c.c);
      const left = x > W * 0.7, rect = left ? [x - 176, y - 20, x - 8, y + 18] : [x + 8, y - 20, x + 176, y + 18];
      if (x > 8 && x < W - 8 && y > 8 && y < H - 8 && rects.every((q) => !hit(q, rect))) { rects.push(rect); c.label = { left }; }
    }
    const fmtDeg = (d, pos, neg) => { const a = Math.abs(d), deg = Math.floor(a), min = Math.round((a - deg) * 60); return `${String(deg).padStart(2, '0')}°${String(min).padStart(2, '0')}′${d >= 0 ? pos : neg}`; };
    const text = (s, x, y, { size = 12, weight = 500, color = C.fg, align = 'left', alpha = 1, mono = false, halo = true } = {}) => {
      ctx.font = `${weight} ${size}px ${mono ? C.mono : C.font}`; ctx.textAlign = align; ctx.globalAlpha = alpha;
      if (halo) { ctx.lineWidth = 4; ctx.strokeStyle = C.bg; ctx.lineJoin = 'round'; ctx.strokeText(s, x, y); }
      ctx.fillStyle = color; ctx.fillText(s, x, y); ctx.globalAlpha = 1;
    };

    return function draw(t) {
      const w = canvas.clientWidth; if (!w) return;
      const dpr = Math.min(3, host.pixelRatio || (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1), pw = Math.round(w * dpr);
      if (canvas.width !== pw) { canvas.width = pw; canvas.height = Math.round((pw * H) / W); }
      const k = pw / W, vw = view(t);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';

      // world layer (zoomed)
      ctx.setTransform(k * vw.z, 0, 0, k * vw.z, k * (W / 2 - vw.cx * vw.z), k * (H / 2 - vw.cy * vw.z));
      const lw = 1 / vw.z;
      ctx.strokeStyle = C.fg; ctx.globalAlpha = 0.09; ctx.lineWidth = 0.8 * lw; ctx.stroke(map._gratPath);
      const sweep = ease(t / 1.1);
      const edge = -0.1 * H + 1.25 * H * sweep;                                 // a scan line reveals the land, top to bottom
      ctx.save(); ctx.beginPath(); ctx.rect(-W, -H, W * 3, edge + H); ctx.clip();
      ctx.globalAlpha = 0.24; ctx.lineWidth = 0.7 * lw; ctx.stroke(map._hexPath);
      ctx.globalAlpha = 0.42; ctx.lineWidth = 0.9 * lw; ctx.stroke(map._landPath);          // the coast, so the place is recognisable
      ctx.restore();
      if (sweep < 1) { ctx.globalAlpha = 0.55 * (1 - sweep); ctx.fillStyle = C.fg; ctx.fillRect(-W, edge - 1 * lw, W * 3, 2 * lw); }

      // places attendees come from: a wave outward from the event
      for (const c of cl) {
        const a = ease((t - 1.3 - (c.d / maxD) * 1.5) / 0.4); if (a <= 0) continue;
        const p = new Path2D(); hexTo(p, c.c[0], c.c[1], S * 0.9 * (0.6 + 0.4 * a));
        ctx.globalAlpha = a * Math.min(0.55, 0.16 + 0.1 * c.n); ctx.fillStyle = C.fg; ctx.fill(p);
        ctx.globalAlpha = a * 0.7; ctx.lineWidth = 1 * lw; ctx.stroke(p);
      }
      // the places where someone the community knows comes from: bright
      knownCells.forEach((c, i) => {
        const a = ease((t - 2.6 - i * 0.14) / 0.35); if (a <= 0) return;
        const p = new Path2D(); hexTo(p, c.c[0], c.c[1], S * 0.9);
        ctx.globalAlpha = a; ctx.fillStyle = C.fg; ctx.fill(p);
        const ring = (t * 0.6 + i * 0.13) % 1, rp = new Path2D(); hexTo(rp, c.c[0], c.c[1], S * (1 + ring * 1.4));
        ctx.globalAlpha = a * (1 - ring) * 0.5; ctx.lineWidth = 1 * lw; ctx.stroke(rp);
      });
      // the event: a solid hex with a slow hex pulse
      const ea = ease((t - 0.9) / 0.5);
      if (ea > 0) {
        const p = new Path2D(); hexTo(p, destC[0], destC[1], S * 1.05);
        ctx.globalAlpha = ea; ctx.fillStyle = C.fg; ctx.fill(p);
        for (let j = 0; j < 2; j++) { const ring = (t * 0.45 + j * 0.5) % 1, rp = new Path2D(); hexTo(rp, destC[0], destC[1], S * (1.3 + ring * 3)); ctx.globalAlpha = ea * (1 - ring) * 0.55; ctx.lineWidth = 1.2 * lw; ctx.stroke(rp); }
      }
      ctx.globalAlpha = 1;

      // screen layer: labels, viewfinder, readout, minimap, legend
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const [sx, sy] = toScreen(vw, ...destC);
      if (ea > 0) {
        const b = 34 + 50 * (1 - ease((t - 0.9) / 1.4)), L = 12;
        ctx.strokeStyle = C.fg; ctx.globalAlpha = 0.85 * ea; ctx.lineWidth = 1.4;
        for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.beginPath(); ctx.moveTo(sx + ux * b, sy + uy * (b - L)); ctx.lineTo(sx + ux * b, sy + uy * b); ctx.lineTo(sx + ux * (b - L), sy + uy * b); ctx.stroke(); }
        text(ev.name, sx + 46, sy - 22, { size: 17, weight: 700, alpha: ea });
        text(`${ev.city} · ${eventDates(ev)}`, sx + 46, sy - 4, { size: 12.5, color: C.muted, alpha: ea });
      }
      for (const c of knownCells) {
        if (!c.label) continue;
        const i = knownCells.indexOf(c), a = ease((t - 2.8 - i * 0.14) / 0.4); if (a <= 0) continue;
        const [x, y] = toScreen(vw, ...c.c), r = c.known[0], al = c.label.left ? 'right' : 'left', lx = c.label.left ? x - 12 : x + 12;
        text(cut(`${r.a.first} ${r.a.last}`, 22) + (c.known.length > 1 ? ` +${c.known.length - 1}` : ''), lx, y - 6, { size: 13, weight: 600, align: al, alpha: a });
        text('known by ' + r.person.owners.map((o) => (o.me && o.name === 'Me' ? 'you' : o.name)).join(' + '), lx, y + 9, { size: 11, color: C.muted, align: al, alpha: a });
      }
      // readout (top left), on a dark backing so the grid does not run through it
      const ra = ease(t / 0.8);
      ctx.globalAlpha = 0.82 * ra; ctx.fillStyle = C.bg; ctx.fillRect(8, 8, 330, 64); ctx.fillRect(8, H - 34, 420, 28); ctx.globalAlpha = 1;
      text(`${ev.name.toUpperCase()} · ${ev.city.toUpperCase()}`, 18, 22, { size: 12, weight: 700, mono: true, alpha: ra, halo: false });
      text(`${eventDates(ev).toUpperCase()} · ${ev.attendees.length} ATTENDING · ${m.known.length} KNOWN`, 18, 40, { size: 11, mono: true, color: C.muted, alpha: ra, halo: false });
      text(`LAT ${fmtDeg(ev.lat, 'N', 'S')}  LON ${fmtDeg(ev.lon, 'E', 'W')}  ZOOM ×${vw.z.toFixed(2)}`, 18, 58, { size: 11, mono: true, color: C.muted, alpha: ra, halo: false });
      // minimap (top right): all of the map, and the box we are looking at
      const mw = 160, mh = (mw * H) / W, mx0 = W - mw - 16, my0 = 16, ms = mw / W;
      ctx.globalAlpha = 0.9 * ra; ctx.fillStyle = C.bg; ctx.fillRect(mx0, my0, mw, mh);
      ctx.strokeStyle = C.fg; ctx.globalAlpha = 0.35 * ra; ctx.lineWidth = 1; ctx.strokeRect(mx0, my0, mw, mh);
      ctx.save(); ctx.translate(mx0, my0); ctx.scale(ms, ms); ctx.globalAlpha = 0.45 * ra; ctx.lineWidth = 1 / ms; ctx.stroke(map._landPath); ctx.restore();
      ctx.globalAlpha = 0.9 * ra; ctx.lineWidth = 1.2;
      ctx.strokeRect(mx0 + (vw.cx - W / 2 / vw.z) * ms, my0 + (vw.cy - H / 2 / vw.z) * ms, (W / vw.z) * ms, (H / vw.z) * ms);
      ctx.globalAlpha = 1; ctx.fillStyle = C.fg; ctx.beginPath(); ctx.arc(mx0 + destC[0] * ms, my0 + destC[1] * ms, 2.2, 0, 6.283); ctx.fill();
      // legend (bottom left)
      const ly = H - 18, lg = (x, fill) => { const p = new Path2D(); hexTo(p, x, ly, 6); ctx.globalAlpha = ra; ctx.strokeStyle = C.fg; ctx.lineWidth = 1; ctx.fillStyle = C.fg; if (fill === 1) ctx.fill(p); else { ctx.globalAlpha = ra * 0.35; ctx.fill(p); ctx.globalAlpha = ra; } ctx.stroke(p); };
      lg(24, 0.3); text('where attendees come from', 36, ly, { size: 11, mono: true, color: C.muted, alpha: ra, halo: false });
      lg(232, 1); text('known by someone in the community', 244, ly, { size: 11, mono: true, color: C.muted, alpha: ra, halo: false });
      ctx.globalAlpha = 1;
    };
  }

  function define() {
    if (customElements.get('founder-tables-outreach')) return;

    class FounderTablesOutreach extends HTMLElement {
      constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
        this._cfg = normalizeConfig();
        this.store = null;
        this.s = emptyState();
        this.drafts = new Map();   // edited message text, by card
        this.pending = new Set();  // cards waiting for "I sent it"
        this.open = new Set();     // expanded "also fits" cards
        this.tab = 'find';
        this.report = null;
        this.log = [];             // import log lines shown in the terminal panel
        this.importOpen = null;    // null: open until the first network is added
        this._saveTimer = 0;
      }

      /** Host configuration; see README. Can be set before or after the element is attached. */
      set config(c) { this._cfg = normalizeConfig(c); if (this._started) this.start(); }
      get config() { return this._cfg; }

      connectedCallback() {
        if (this._started) return;
        const src = this.getAttribute('config-src');
        if (src && !this._cfgLoaded) {
          this._cfgLoaded = true;
          fetch(src).then((r) => r.json()).then((c) => { this._cfg = normalizeConfig(c); this.start(); }).catch(() => this.start());
        } else queueMicrotask(() => { if (!this._started) this.start(); });
      }

      get storageKey() { return 'founder-tables-outreach:' + (this.getAttribute('namespace') || 'default'); }
      today() { return this._cfg.today || new Date().toISOString().slice(0, 10); }
      emit(name, detail) { this.dispatchEvent(new CustomEvent('ft-' + name, { detail, bubbles: true, composed: true })); }

      // ---- storage: localStorage by default; a host can set `el.store = { load(), save(data) }` (sync or async) ----
      async load() {
        try {
          if (this.store) return deserialize(await this.store.load());
          const raw = localStorage.getItem(this.storageKey);
          return deserialize(raw ? JSON.parse(raw) : null);
        } catch { return emptyState(); }
      }
      save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
          const data = serialize(this.s);
          try {
            if (this.store) await this.store.save(data);
            else localStorage.setItem(this.storageKey, JSON.stringify(data));
          } catch { this.toast('Could not save in this browser (storage full or blocked). Your work stays until you close the page.'); }
        }, 250);
      }
      async wipe() {
        try { if (this.store && this.store.clear) await this.store.clear(); else if (this.store) await this.store.save(serialize(emptyState())); else localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
        this.s = emptyState(); this.drafts.clear(); this.pending.clear(); this.report = null; this.log = [];
        this.renderAll();
      }

      async start() {
        this._started = true;
        this._ready = false;   // host calls wait in the queue while the saved state (re)loads, so the load cannot overwrite them
        const run = (this._run || 0) + 1; this._run = run;
        const prev = this.s;
        const loaded = await this.load();
        if (run !== this._run) return;   // a newer start (the host set config again) owns the state
        this.s = loaded;
        if (prev.networks.some((n) => n.sample) && !this.s.networks.length) this.s.networks = prev.networks; // keep a sample across a config change
        const st = this.s.settings, c = this._cfg;
        st.topic = st.topic || (c.topics[0] ? c.topics[0].key : 'custom');
        st.date = st.date ?? c.date; st.place = st.place ?? c.place; st.signature = st.signature ?? c.signature;
        st.eventWord = st.eventWord || 'dinner'; st.theme = st.theme || ''; st.prompt = st.prompt || '';
        this._ready = true;
        this.renderAll();
        for (const [fn, args] of (this._queue || []).splice(0)) this[fn](...args);   // host calls made before the state had loaded
      }

      // ---- state helpers ----
      get eventId() { return this._cfg.id; }
      recs() { return (this.s.outreach[this.eventId] ||= {}); }
      setRec(key, rec) {
        const recs = this.recs();
        if (rec) recs[key] = rec; else delete recs[key];
        this.save(); this.refresh();
      }
      topic() {
        const st = this.s.settings;
        const custom = () => customTopic({ ...(st.custom || {}), topic: st.theme });
        if (st.topic === 'custom') return custom();
        if (st.topic === 'find' && st.find) return findTopic(st.find);
        const base = this._cfg.topics.find((t) => t.key === st.topic) || custom();
        if (st.field && st.field.org && st.field.org.length && base.rule && base.rule.title) { // founders in a field: same title rule, company must match the field
          const terms = st.field.org.map(escapeRe).join('|');
          return { ...base, label: `${base.label} · ${st.field.label}`, rule: { ...base.rule, org: new RegExp('(?<![\\p{L}])(?:' + terms + ')', 'iu'), req: 'both' } };
        }
        return base;
      }
      people() { return mergePeople(this.s.networks); }
      toast(msg) { const t = this.root.getElementById('toast'); if (!t) return; t.textContent = msg; clearTimeout(this._toastTimer); this._toastTimer = setTimeout(() => (t.textContent = ''), 4000); }

      // ---- rendering ----
      refresh() { this.renderConnected(); this.renderScopeBar(); this.renderResults(); this.renderMap(); this.renderEvent(); this.renderTracker(); this.renderTabs(); this.syncVisibility(); }

      /**
       * Simple mode assumes the networks are already connected (LinkedIn tokens on the platform): the prompt, a strip of
       * who is connected, then one results area. Attaching a file is tucked behind "Connect your LinkedIn".
       */
      syncVisibility() {
        if (!this._cfg.simple) return;
        const st = this.s.settings, show = !!st.prompt && this.s.networks.length > 0;
        const el = (id) => this.root.getElementById(id);
        if (el('import')) el('import').hidden = !this.showImport;
        if (el('term')) el('term').hidden = true;
        if (el('work')) el('work').hidden = !show;
      }
      /** In simple mode the map shows when the list is filtered to an event; elsewhere it is a tab. */
      evtOn() { return this._cfg.simple ? this.s.settings.scope === 'event' && !!this.ctx().attending : this.tab === 'event'; }
      netOn() { return this._cfg.simple ? !this.evtOn() : this.tab === 'map'; }

      renderConnected() {
        const box = this.root.getElementById('connected');
        if (!box) return;
        if (!this._cfg.simple) return box.replaceChildren();
        const nets = this.s.networks, people = this.people().length;
        const toggle = h('button', { type: 'button', class: 'link', text: this.showImport ? 'Done' : 'Connect your LinkedIn', onclick: () => { this.showImport = !this.showImport; this.importOpen = true; this.renderImport(); this.renderConnected(); this.syncVisibility(); } });
        if (!nets.length) return box.replaceChildren(h('div', { class: 'conn' }, h('span', { class: 'muted', text: 'No one in the community has connected their LinkedIn yet.' }), toggle));
        const label = (n) => (n.me && n.name === 'Me' ? 'You' : n.name);
        box.replaceChildren(h('div', { class: 'conn' },
          h('span', { class: 'eyebrow', text: 'Connected with LinkedIn' }),
          h('div', { class: 'connlist' }, nets.map((n) => h('span', { class: 'cn' }, h('i', { class: 'av', text: label(n)[0] }), h('b', { text: label(n) }), n.role && h('span', { class: 'muted', text: n.role }), h('span', { class: 'n', text: n.rows.length.toLocaleString('en-US') })))),
          h('span', { class: 'muted connsum', text: `${nets.length} network${nets.length === 1 ? '' : 's'} · ${people.toLocaleString('en-US')} people, merged` }),
          toggle));
      }

      /** Simple mode: how many people the search found, and Everyone / Attending <event>. */
      renderScopeBar() {
        const box = this.root.getElementById('scopebar');
        if (!box) return;
        if (!this._cfg.simple || !this.people().length) return box.replaceChildren();
        const st = this.s.settings, rctx = this.ctx(), t = this.topic();
        const scope = st.scope === 'event' && rctx.attending ? 'event' : 'all';
        const set = (v) => () => { st.scope = v; this.save(); this.renderScopeBar(); this.renderResults(); this.renderMap(); this.renderEvent(); this.renderTabs(); if (v === 'event') this.kickEvt(); else this.kickNet(); };
        const ev = this.currentEvent(), known = rctx.attending ? rctx.attending.size : 0;
        const n = this.fieldCount();
        box.replaceChildren(
          h('p', { class: 'scopehead' }, h('b', { text: `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'}` }), st.mode === 'find' ? ' match in your community’s network' : ' on this field in your community’s network', h('span', { class: 'muted', text: ` · ${t.custom ? (st.theme || 'your keywords') : t.label}` })),
          rctx.attending ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Who to include' },
            h('button', { type: 'button', class: 'segb', 'aria-pressed': String(scope === 'all'), onclick: set('all'), text: 'Everyone' }),
            h('button', { type: 'button', class: 'segb', 'aria-pressed': String(scope === 'event'), onclick: set('event'), text: `Attending ${ev.name} · ${known}` })) : '');
      }

      renderAll() {
        const c = this._cfg;
        this.root.replaceChildren(
          h('style', { text: STYLE }),
          h('div', { class: 'ft' + (c.simple ? ' simple' : '') },
            h('div', { class: 'head' },
              h('span', { class: 'eyebrow', text: 'Founder tables' }),
              h('h2', { text: c.title }),
              h('p', { class: 'lede', text: c.intro })),
            h('div', { class: 'prompt', id: 'prompt' }),
            !c.simple && h('div', { class: 'steps' },
              h('div', { class: 'step' }, h('b', { text: '1. Say what you want' }), h('span', { class: 'muted', text: 'A dinner, a place, who should be there.' })),
              h('div', { class: 'step' }, h('b', { text: '2. Everyone adds a network' }), h('span', { class: 'muted', text: 'Yours, a Venture Partner’s, a partner’s. One LinkedIn export each.' })),
              h('div', { class: 'step' }, h('b', { text: '3. See where it connects' }), h('span', { class: 'muted', text: 'Who knows whom, then invite from here.' }))),
            h('div', { id: 'connected' }),
            h('div', { id: 'import' }),
            h('div', { id: 'term' }),
            h('div', { class: 'work', id: 'work' },
              h('div', { id: 'scopebar', class: 'scopebar' }),
              h('div', { class: 'tabs', role: 'tablist', id: 'tabs' }),
              h('div', { class: 'panel', id: 'panel-find', role: 'tabpanel' }, h('div', { id: 'banner' }), h('div', { id: 'results', class: 'panel' })),
              h('div', { class: 'panel', id: 'panel-map', role: 'tabpanel', hidden: true }),
              h('div', { class: 'panel', id: 'panel-event', role: 'tabpanel', hidden: true }),
              h('div', { class: 'panel', id: 'panel-track', role: 'tabpanel', hidden: true })),
            c.simple
              ? h('div', { hidden: true }, h('div', { class: 'controls', id: 'controls' }))
              : h('details', { class: 'adjust' }, h('summary', { text: 'Adjust the details' }), h('div', { class: 'adjust-body' }, h('div', { class: 'controls', id: 'controls' }))),
            h('div', { class: 'toast', id: 'toast', role: 'status', 'aria-live': 'polite' }),
            c.simple ? h('p', { class: 'foot', text: 'Connections stay in the browser · emails are never stored · nothing is sent for you' }) : h('div', { class: 'foot' },
              h('div', { class: 'privacy' }, h('span', { innerHTML: SVG_LOCK }),
                h('span', { text: 'Your LinkedIn export is read in this browser only and never uploaded. Email addresses are ignored. Nothing is sent for you: the button copies your message and opens the person on LinkedIn, and you press send.' })),
              h('span', { text: 'Matching is plain rules on job titles and company names, so the same data always gives the same list.' }))));
        this.renderPrompt(); this.renderImport(); this.renderTerm(); this.renderControls(); this.refresh();
      }

      // ---- the prompt ----
      async applyPrompt(text) {
        const st = this.s.settings, c = this._cfg;
        st.prompt = text;
        let plan;
        try { plan = c.interpret ? await c.interpret(text, { topics: c.topics, events: c.events || [], interpretPrompt }) : interpretPrompt(text, c.topics, c.events || []); } catch { plan = interpretPrompt(text, c.topics, c.events || []); }
        plan = plan || {};
        st.mode = plan.mode === 'find' ? 'find' : 'event';
        st.find = plan.find || null;
        if (st.mode === 'find') { st.place = plan.place || ''; st.date = plan.date || ''; st.event = plan.eventId || null; }
        if (plan.eventWord) st.eventWord = plan.eventWord;
        if (plan.place) st.place = plan.place;
        if (plan.date) st.date = plan.date;
        st.theme = plan.theme || '';
        st.field = plan.field || null;
        if (plan.topicKey) { st.topic = plan.topicKey; if (plan.custom) st.custom = { title: plan.custom.title || '', org: plan.custom.org || '' }; }
        const ev = this.events().find((e) => e.id === plan.eventId) || (st.mode === 'find' ? null : this.events().find((e) => this.eventInTown(e)));
        if (ev) { st.event = ev.id; if (!plan.date) st.date = longDate(ev.start); }
        this.plan = plan;
        this.save();
        if (!plan.topicKey) this.toast('Say who you are looking for. Try: “a CTO with battery experience” or “a founder dinner in Stockholm”.');
        if (plan.topicKey && this.people().length) {
          const fl = this.fitLine(), el = ev ? this.eventLine(ev) : '';
          if (fl) this.logAdd([[`$ plan “${text.length > 48 ? text.slice(0, 47) + '…' : text}”`, 'cmd'], [fl, 'hot'], ...(el ? [[el, 'hot']] : [])]);
        }
        this.renderPrompt(); this.renderTerm(); this.renderControls(); this.refresh();
      }

      renderPrompt() {
        const st = this.s.settings, c = this._cfg, box = this.root.getElementById('prompt');
        const area = h('textarea', { rows: 2, 'aria-label': 'Who are you looking for', placeholder: c.placeholder ?? ((c.examples && c.examples[0]) || 'make me a dinner in oslo for sustainable industry people'), value: st.prompt || '' });
        const go = () => { const t = area.value.trim(); if (t) this.applyPrompt(t); };
        area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
        const examples = c.examples || ['make me a dinner in oslo for sustainable industry people', 'a lunch in stockholm for AI founders'];
        const plan = this.plan, t = this.topic();
        const hasTheme = st.theme || (plan && plan.topicKey);
        const tags = hasTheme && st.mode === 'find' ? [
          ['Looking for', t.label], st.find && st.find.forWhom && ['For', st.find.forWhom], st.place && ['Where', st.place],
          (() => { const ev = this.currentEvent(); return ev && this.eventInTown(ev) && ['Event', `${ev.name} · ${eventDates(ev)}`]; })(),
        ].filter(Boolean) : hasTheme ? [
          ['Type', st.eventWord], st.place && ['Place', st.place], st.date && ['Date', st.date],
          ['Looking for', t.custom ? (st.theme || 'your keywords') : t.label],
          (() => { const ev = this.currentEvent(); return ev && this.eventInTown(ev) && ['Event', `${ev.name} · ${eventDates(ev)}`]; })(),
        ].filter(Boolean) : [];
        box.replaceChildren(
          h('div', { class: 'prompt-box' }, area, h('button', { type: 'button', class: 'btn', text: c.simple ? 'Find' : 'Plan it', onclick: go })),
          tags.length ? h('div', { class: 'plan' }, tags.map(([k, v]) => h('span', { class: 'tag' }, h('span', { class: 'muted', text: k + ' ' }), h('b', { text: v })))) : '',
          examples.length ? h('div', { class: 'examples' }, 'Try', examples.map((ex) => h('button', { type: 'button', class: 'btn ghost small', text: ex, onclick: () => { area.value = ex; go(); } }))) : '');
      }

      renderImport() {
        const box = this.root.getElementById('import');
        const real = this.s.networks.filter((n) => !n.sample);
        const owner = h('input', { type: 'text', id: 'owner-name', value: 'Me', autocomplete: 'off' });
        const mine = h('input', { type: 'checkbox', id: 'owner-me', checked: true });
        const ownerRole = h('input', { type: 'text', id: 'owner-role', ...(this._cfg.simple ? {} : { list: 'roles' }), placeholder: this._cfg.simple ? 'e.g. Venture Partner' : 'Platform team, Venture Partner, portfolio founder…', autocomplete: 'off' });
        const ownerUrl = h('input', { type: 'url', id: 'owner-url', placeholder: 'https://www.linkedin.com/in/…', autocomplete: 'off' });
        const urlField = h('label', { class: 'field', hidden: true, style: 'min-width:220px;flex:1' }, h('span', { text: 'Their LinkedIn profile (optional, to open them for an intro ask)' }), ownerUrl);
        mine.addEventListener('change', () => {
          urlField.hidden = mine.checked;
          if (!mine.checked && owner.value === 'Me') { owner.value = ''; owner.focus(); }
          if (mine.checked && !owner.value) owner.value = 'Me';
        });
        const input = h('input', { type: 'file', class: 'file', id: 'csv', accept: '.csv,text/csv' });
        const addFile = async (file) => {
          if (!file) return;
          const res = parseConnections(await file.text());
          const name = owner.value.trim() || (mine.checked ? 'Me' : 'Someone');
          if (res.report.error) { this.logAdd([[`$ add “${name}” < ${file.name}`, 'cmd'], [`✗ ${res.report.error}`, 'warn']]); return this.renderTerm(); }
          this.s.networks = this.s.networks.filter((n) => !n.sample && !(n.name === name && n.me === mine.checked));
          this.purgeSampleRecs();
          this.s.networks.push({ id: 'n' + Date.now().toString(36), name, role: ownerRole.value.trim(), me: mine.checked, url: safeProfileUrl(ownerUrl.value), rows: res.rows });
          this.report = { ...res.report, name, mine: mine.checked };
          this.save(); this.emit('import', { owner: name, mine: mine.checked, count: res.rows.length });
          this.logAdd(this.importLines(file.name, name, res.report));
          this.renderImport(); this.renderTerm(); this.refresh();
        };
        input.addEventListener('change', () => { addFile(input.files[0]); input.value = ''; });
        const drop = h('div', { class: 'drop' },
          h('div', { class: 'row' }, h('label', { class: 'btn', for: 'csv', text: this._cfg.simple ? 'Attach LinkedIn connections' : 'Add Connections.csv' }), input,
            h('span', { class: 'muted', style: 'font-size:13.5px', text: this._cfg.simple ? 'Your own LinkedIn: an export here, your API token in production.' : 'or drop it here. LinkedIn → Settings & Privacy → Data privacy → Get a copy of your data → Connections.' })),
          h('div', { class: 'row' },
            h('label', { class: 'field', style: 'min-width:160px;flex:1' }, h('span', { text: 'Whose connections?' }), owner),
            h('label', { class: 'field', style: 'min-width:200px;flex:1' }, h('span', { text: 'Their role in the community' }), ownerRole,
              !this._cfg.simple && h('datalist', { id: 'roles' }, ['Platform team', 'Venture Partner', 'Portfolio founder', 'Corporate partner'].map((r) => h('option', { value: r })))),
            h('label', { class: 'check' }, mine, 'My own (invite directly)'),
            urlField));
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('over'));
        drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFile(e.dataTransfer.files[0]); });

        const nets = h('div', { class: 'nets' }, this.s.networks.map((n) => h('span', { class: 'net' },
          h('b', { text: n.name }), n.role && h('span', { class: 'muted', text: n.role }), h('span', { class: 'n', text: String(n.rows.length) }),
          n.sample ? h('span', { class: 'badge plain', text: this._cfg.sample.label || 'sample' })
            : h('button', { type: 'button', 'aria-label': `Remove ${n.name}'s connections`, text: '×', onclick: () => {
              this.s.networks = this.s.networks.filter((x) => x !== n); this.save(); this.logAdd([[`$ remove “${n.name}”`, 'cmd'], [`✓ ${this.people().length} people left in ${this.s.networks.length} network${this.s.networks.length === 1 ? '' : 's'}`, 'ok']]); this.renderImport(); this.renderTerm(); this.refresh();
            } }))));
        const actions = h('div', { class: 'row' },
          !real.length && this._cfg.sample && !this.s.networks.some((n) => n.sample) && h('button', { type: 'button', class: 'btn ghost small', text: 'Try with invented sample people', onclick: () => this.loadSample() }),
          (!this._cfg.simple && (real.length > 0 || Object.keys(this.recs()).length > 0)) && h('button', { type: 'button', class: 'btn quiet small', text: 'Delete my data', onclick: () => { if (confirm('Delete the connections, statuses and settings this tool stored in this browser?')) this.wipe(); } }));
        const det = h('details', { class: 'import', open: this.importOpen ?? !real.length });
        det.addEventListener('toggle', () => { this.importOpen = det.open; });
        box.replaceChildren(det);
        det.append(
          h('summary', { text: real.length ? `Your networks (${real.reduce((a, n) => a + n.rows.length, 0)} connections)` : 'Add your connections' }),
          h('div', { class: 'import-body' }, drop, nets, actions));
      }

      // ---- the import log: real facts about what was just read, printed like a terminal ----
      logAdd(lines) {
        for (const [text, kind] of lines) this.log.push({ text, kind: kind || '', fresh: true });
        this.log = this.log.slice(-9);
      }
      importLines(file, name, report) {
        const people = this.people(), nets = this.s.networks;
        const shared = people.filter((p) => p.owners.length > 1).length;
        const out = [[`$ add “${name}” < ${file}`, 'cmd'], [`✓ ${report.accepted} connections read · emails ignored · nothing left this browser`, 'ok']];
        for (const w of report.warnings) out.push([`! ${w}`, 'warn']);
        out.push([`✓ ${nets.length} network${nets.length === 1 ? '' : 's'} · ${people.length} people · merged by profile URL${shared ? ` · ${shared} known by more than one of you` : ''}`, 'hot']);
        const fit = this.fitLine();
        if (fit) out.push([fit, 'hot']);
        const ev = this.currentEvent(), el = ev && this.eventInTown(ev) ? this.eventLine(ev) : '';
        if (el) out.push([el, 'hot']);
        return out;
      }
      /** Everyone across the networks who fits the field (not one per company). */
      fieldCount() { const t = this.topic(); return this.people().filter((p) => fitFor(p, t)).length; }
      /** "→ 145 connections on this field", or '' before a theme is set. */
      fitLine() {
        const t = this.topic(), st = this.s.settings;
        if (!this.people().length || (t.custom && !t.rule.title && !t.rule.org) || !(st.theme || st.topic !== 'custom')) return '';
        const n = this.fieldCount();
        return `→ ${n} ${n === 1 ? 'connection' : 'connections'} on this field · “${t.custom ? st.theme : t.label}”`;
      }
      renderTerm() {
        const box = this.root.getElementById('term');
        if (!box) return;
        if (!this.log.length) return box.replaceChildren();
        let k = 0;
        const rows = this.log.map((l) => h('div', { class: `tl ${l.kind}${l.fresh ? ' fresh' : ''}`, style: l.fresh ? `--d:${(k++ * 0.75).toFixed(2)}s;--n:${Math.min(l.text.length, 90)}` : null, text: l.text }));
        for (const l of this.log) l.fresh = false;
        box.replaceChildren(h('div', { class: 'term', 'aria-live': 'polite', 'aria-label': 'Import log' },
          h('div', { class: 'term-bar' }, h('i'), h('i'), h('i'), h('span', { text: 'founder-tables · import log' })),
          h('div', { class: 'term-body' }, rows)));
      }

      /**
       * Add one member's connections from your own server, e.g. rows fetched with their LinkedIn token
       * (lib/linkedin-dma.mjs, scripts/linkedin-sync.mjs). Only these five fields are kept; anything else is ignored.
       * Pass `rows` ([{ first, last, url, company, position }]) or `csv` (a Connections.csv text).
       */
      addNetwork(opts = {}) {
        if (!this._ready) { (this._queue ||= []).push(['addNetwork', [opts]]); return { queued: true }; }   // the saved state is still loading
        const { name, role = '', me = false, rows = null, csv = null, url = '' } = opts;
        let list = rows;
        if (!list && csv) { const r = parseConnections(csv); if (r.report.error) throw new Error(r.report.error); list = r.rows; }
        if (!name || !Array.isArray(list)) throw new Error('addNetwork needs a name and rows (or csv).');
        const clean = list.map((r) => ({ first: String(r.first || '').trim(), last: String(r.last || '').trim(), url: String(r.url || '').trim(), company: String(r.company || '').trim(), position: String(r.position || '').trim() })).filter((r) => r.first || r.last);
        this.s.networks = this.s.networks.filter((n) => !n.sample && !(n.name === name && n.me === !!me));
        this.s.networks.push({ id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name, role, me: !!me, url: safeProfileUrl(url), rows: clean });
        this.save(); this.emit('import', { owner: name, mine: !!me, count: clean.length });
        this.logAdd(this.importLines('API', name, { accepted: clean.length, warnings: [] }));
        this.renderImport(); this.renderTerm(); this.refresh();
        return { accepted: clean.length };
      }

      /** Add an event's attendee list (CSV text) to a configured event. Matched to the networks by LinkedIn URL only. */
      addAttendees(eventId, csvText, source = 'an attendee list you added') {
        if (!this._ready) { (this._queue ||= []).push(['addAttendees', [eventId, csvText, source]]); return { queued: true }; }
        const ev = (this._cfg.events || []).find((e) => e.id === eventId);
        if (!ev) throw new Error('No event with id ' + eventId);
        const { rows, report } = parseAttendees(csvText);
        if (report.error) throw new Error(report.error);
        (this.s.attendees ||= {})[eventId] = { source, rows };
        this.save();
        const known = matchEvent(this.events().find((e) => e.id === eventId), this.people()).known.length;
        this.logAdd([[`$ add attendees “${ev.name}” < ${source}`, 'cmd'], [`✓ ${report.accepted} people · ${report.withUrl} with a LinkedIn URL · ${known} known by your community`, 'hot'], ...report.warnings.map((w) => [`! ${w}`, 'warn'])]);
        this.renderTerm(); this.refresh();
        return { accepted: report.accepted, withUrl: report.withUrl, known };
      }

      loadSample() {
        const sample = this._cfg.sample;
        this.s.networks = sample.networks.map((n, i) => ({ id: 'sample' + i, name: n.name, role: n.role, me: !!n.me, sample: true, url: '', rows: n.rows.map(([first, last, url, company, position]) => ({ first, last, url: url || '', company, position })) }));
        this.logAdd([['$ load invented sample', 'cmd'], [`✓ ${sample.networks.reduce((a, n) => a + n.rows.length, 0)} invented connections in ${sample.networks.length} networks`, 'ok']]);
        this.renderImport(); this.renderTerm(); this.refresh();
      }
      purgeSampleRecs() {
        for (const recs of Object.values(this.s.outreach)) for (const [k, r] of Object.entries(recs)) if (r.sample) delete recs[k];
      }

      renderControls() {
        const st = this.s.settings, c = this._cfg;
        const sel = h('select', { id: 'topic' }, c.topics.map((t) => h('option', { value: t.key, text: t.label })), h('option', { value: 'custom', text: 'Something else…' }));
        sel.value = st.topic;
        const custom = st.custom || (st.custom = { title: '', org: '' });
        const customBox = h('div', { class: 'controls', style: 'grid-column:1/-1', hidden: st.topic !== 'custom' },
          h('label', { class: 'field' }, h('span', { text: 'Job titles, comma-separated' }), h('input', { type: 'text', value: custom.title, placeholder: 'procurement, sourcing', oninput: (e) => { custom.title = e.target.value; this.save(); this.refresh(); } })),
          h('label', { class: 'field' }, h('span', { text: 'Company keywords, comma-separated' }), h('input', { type: 'text', value: custom.org, placeholder: 'steel, cement', oninput: (e) => { custom.org = e.target.value; this.save(); this.refresh(); } })));
        sel.addEventListener('change', () => { st.topic = sel.value; customBox.hidden = st.topic !== 'custom'; this.save(); this.renderPrompt(); this.refresh(); });
        const text = (id, label, key, ph) => h('label', { class: 'field' }, h('span', { text: label }), h('input', { type: 'text', id, value: st[key] || '', placeholder: ph, autocomplete: 'off', oninput: (e) => { st[key] = e.target.value; this.save(); this.renderResults(); } }));
        this.root.getElementById('controls').replaceChildren(
          h('label', { class: 'field' }, h('span', { text: 'Who are you looking for?' }), sel),
          text('kind', 'Type of event', 'eventWord', 'dinner'), text('date', 'Date', 'date', 'Thursday 4 December'), text('place', 'Place', 'place', 'Oslo'), text('sig', 'Signature', 'signature', '– Your name'), customBox);
      }

      renderTabs() {
        if (this._cfg.simple) {
          const tabs = this.root.getElementById('tabs'); if (tabs) tabs.replaceChildren();
          const show = { find: true, map: this.netOn(), event: this.evtOn(), track: false };
          for (const id of Object.keys(show)) { const pn = this.root.getElementById('panel-' + id); if (pn) pn.hidden = !show[id]; }
          return;
        }
        const due = this.dueFollowUps().length;
        const total = Object.keys(this.recs()).length;
        const tab = (id, label, count, hot) => h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(this.tab === id), onclick: () => { this.tab = id; this.renderTabs(); if (id === 'map') this.kickNet(); if (id === 'event') this.kickEvt(); } },
          label, count > 0 && h('span', { class: 'count' + (hot ? ' due' : ''), text: String(count) }));
        const hasEv = this.events().length > 0;
        if (this.tab === 'map' && this._cfg.simple) this.tab = hasEv ? 'event' : 'find';
        this.root.getElementById('tabs').replaceChildren(...(this._cfg.simple
          ? [hasEv ? tab('event', 'Who’s coming', 0) : null, tab('find', 'Invite', 0), tab('track', 'Sent', due > 0 ? due : total, due > 0)]
          : [tab('find', 'Who to invite', 0), tab('map', 'Where it connects', 0), hasEv ? tab('event', 'Event map', 0) : null, tab('track', 'Outreach', due > 0 ? due : total, due > 0)]));
        for (const id of ['find', 'map', 'event', 'track']) { const pn = this.root.getElementById('panel-' + id); if (pn) pn.hidden = this.tab !== id; }
      }

      // ---- network: clouds of connections, strings to the people who fit ----
      renderMap() {
        this.stopNet();
        const box = this.root.getElementById('panel-map');
        if (!box) return;
        const nets = this.s.networks, topic = this.topic(), people = this.people();
        if (!people.length) return box.replaceChildren(h('p', { class: 'empty', text: 'Add networks above, one export per person, to see where they connect.' }));
        if (topic.custom && !topic.rule.title && !topic.rule.org) return box.replaceChildren(h('p', { class: 'empty', text: 'Describe who you are looking for above first.' }));
        const ranked = rank(people, topic, { outreach: {}, today: this.today() });
        if (!ranked.length) return box.replaceChildren(h('p', { class: 'empty', text: 'No one in these networks fits yet. Add another network.' }));
        const shown = ranked.slice(0, this._cfg.simple ? 8 : 12);
        const shared = ranked.filter((r) => r.p.owners.length > 1).length;
        const tile = (n, small) => { const b = h('b', { text: '0' }); b.dataset.to = String(n); return h('div', { class: 'insight' }, b, h('span', { class: 'muted', text: small })); };
        const canvas = h('canvas', { class: 'netcv', role: 'img', 'aria-label': `${nets.length} networks, ${people.length} people, ${ranked.length} who fit, ${shared} known by more than one of you` });
        if (this._cfg.simple) {
          box.replaceChildren(h('div', { class: 'map' }, canvas), h('ul', { class: 'sr' }, shown.map((r) => h('li', { text: `${r.p.first} ${r.p.last}, ${r.p.position}${r.p.company ? ', ' + r.p.company : ''}. Known by ${r.p.owners.map((o) => o.name).join(' and ')}.` }))));
          const rel = new Map();   // per network: how many of its people this search is about
          for (const p of people) if (fitFor(p, topic)) for (const o of p.owners) rel.set(o, (rel.get(o) || 0) + 1);
          this._net = { canvas, nets, people, shown, rel };
          this.kickNet();
          return;
        }
        box.replaceChildren(
          h('div', { class: 'insights' },
            tile(this.fieldCount(), this.fieldCount() === 1 ? 'connection on this field' : 'connections on this field'),
            tile(people.length, `people in ${nets.length} network${nets.length > 1 ? 's' : ''}, merged by profile URL`),
            tile(ranked.length, 'fit what you are looking for, one per company'),
            tile(shared, shared === 1 ? 'is known by more than one of you: the warmest way in' : 'are known by more than one of you: the warmest ways in')),
          h('div', { class: 'map' }, canvas),
          h('ul', { class: 'sr' }, shown.map((r) => h('li', { text: `${r.p.first} ${r.p.last}, ${r.p.position}${r.p.company ? ', ' + r.p.company : ''}. Known by ${r.p.owners.map((o) => o.name).join(' and ')}.` }))),
          h('p', { class: 'muted', style: 'font-size:13px', text: `Showing the best ${shown.length} of ${ranked.length}. Each string is someone in a network who fits; a bright node is known by more than one of you.` }));
        this._net = { canvas, nets, people, shown };
        this.kickNet();
      }

      stopNet() { cancelAnimationFrame(this._raf || 0); this._raf = 0; if (this._ro) { this._ro.disconnect(); this._ro = null; } }

      /** (Re)start the drawing from its first frame, only while the tab is showing. */
      kickNet() {
        const d = this._net;
        if (!d || !this.netOn() || !d.canvas.isConnected) return;
        cancelAnimationFrame(this._raf || 0);
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        for (const b of this.root.querySelectorAll('.insight b[data-to]')) countUp(b, Number(b.dataset.to), reduce ? 0 : 1400);
        const draw = netPainter(this, d);
        if (this._ro) this._ro.disconnect();
        if (typeof ResizeObserver === 'function') { this._ro = new ResizeObserver(() => draw(this._t)); this._ro.observe(d.canvas); }
        if (reduce) { this._t = 99; draw(99); return; }
        const t0 = performance.now();
        const loop = (now) => {
          if (!d.canvas.isConnected || !this.netOn()) { this._raf = 0; return; }
          this._t = (now - t0) / 1000;
          draw(this._t);
          this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
      }


      // ---- event map: who is attending, and who in the community knows them ----
      ownerShort(o) { return (o.me && o.name === 'Me' ? 'You' : o.name) + (o.role ? ` (${o.role})` : ''); }

      renderEvent() {
        this.stopEvt();
        const box = this.root.getElementById('panel-event');
        if (!box) return;
        const evs = this.events(), ev = this.currentEvent(), map = this._cfg.map || (typeof window !== 'undefined' && window.FT_EUROPE);
        if (!ev) return box.replaceChildren();
        if (!map) return box.replaceChildren(h('p', { class: 'empty', text: 'No map data loaded (europe-map.js).' }));
        const fileIn = h('input', { type: 'file', class: 'file', id: 'att-csv', accept: '.csv,text/csv' });
        fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; fileIn.value = ''; if (!f) return; try { this.addAttendees(ev.id, await f.text(), f.name); } catch (e) { this.toast(e.message); } });
        const addList = h('div', { class: 'row' }, h('label', { class: 'btn ghost small', for: 'att-csv', text: ev.attendees.length ? 'Add another attendee list (CSV)' : 'Add the attendee list (CSV)' }), fileIn,
          h('span', { class: 'muted', style: 'font-size:12.5px', text: "The organiser's export, your RSVPs, or a public speaker/partner list. Matched by LinkedIn URL only." }));
        if (!ev.attendees.length) {
          return box.replaceChildren(
            h('div', { class: 'evchips', role: 'group', 'aria-label': 'Events' }, evs.map((e) => h('button', { type: 'button', class: 'evchip', 'aria-pressed': String(e.id === ev.id), onclick: () => { this.s.settings.event = e.id; this.save(); this.renderEvent(); this.kickEvt(); } }, h('b', { text: e.name }), h('span', { class: 'muted', text: `${e.city} · ${eventDates(e)}` })))),
            h('p', { class: 'empty', text: `No attendee list for ${ev.name} yet. Public pages rarely list attendees; add the organiser's export, your own RSVPs, or a speaker/partner list. See docs/event-data.md.` }),
            addList);
        }
        if (ev.lat == null) return box.replaceChildren(h('p', { class: 'empty', text: `Unknown city for the map: ${ev.city}. Add lat/lon to the event.` }), addList);
        const m = matchEvent(ev, this.people());
        const chips = h('div', { class: 'evchips', role: 'group', 'aria-label': 'Events' }, evs.map((e) => h('button', { type: 'button', class: 'evchip', 'aria-pressed': String(e.id === ev.id), onclick: () => {
          this.s.settings.event = e.id; this.save();
          const l = this.eventLine(e); if (l) this.logAdd([[`$ load event “${e.name}”`, 'cmd'], [l, 'hot']]);
          this.renderTerm(); this.renderResults(); this.renderEvent(); this.kickEvt();
        } }, h('b', { text: e.name }), h('span', { class: 'muted', text: `${e.city} · ${eventDates(e)}` }))));
        const tile = (n, small) => { const b = h('b', { text: '0' }); b.dataset.to = String(n); return h('div', { class: 'insight' }, b, h('span', { class: 'muted', text: small })); };
        const canvas = h('canvas', { class: 'netcv', role: 'img', style: `aspect-ratio:${map.w} / ${map.h}`, 'aria-label': `${ev.name} in ${ev.city}, ${eventDates(ev)}: ${ev.attendees.length} attending, ${m.known.length} known by your community` });
        const known = [...m.known].sort((a, b) => b.person.owners.length - a.person.owners.length || a.a.last.localeCompare(b.a.last));
        if (this._cfg.simple) {
          box.replaceChildren(
            h('p', { class: 'evsum' }, h('b', { text: `${m.known.length} of ${ev.attendees.length}` }), ` attending ${ev.name} (${ev.city} · ${eventDates(ev)}) are known by someone in the community.`),
            h('div', { class: 'map' }, canvas),
            h('p', { class: 'muted', style: 'font-size:13px', text: `Attendee list: ${ev.source || 'the organiser'}${ev.invented ? ', invented for this demo' : ''}.` }));
          this._evt = { canvas, ev, evs, m, map };
          this.kickEvt();
          return;
        }
        box.replaceChildren(
          chips,
          h('div', { class: 'insights' },
            tile(m.known.length, 'attending and known by your community'),
            tile(ev.attendees.length, 'attending or partnering'),
            this._cfg.simple ? null : tile(m.companies, 'companies where someone in the community knows someone')),
          h('div', { class: 'map' }, canvas),
          h('p', { class: 'muted', style: 'font-size:13px', text: `Attendee and partner list: ${ev.source || 'from the organiser'}${ev.invented ? ' (invented for this demo)' : ''}. People match your networks by LinkedIn profile URL only.` }),
          this._cfg.simple ? '' : addList,
          this._cfg.simple ? (known.length ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn big', id: 'to-invite', text: `Invite the ${known.length} you know`, onclick: () => { this.s.settings.scope = 'event'; this.save(); this.tab = 'find'; this.renderResults(); this.renderTabs(); } })) : '') : known.length ? h('div', { class: 'more' }, h('span', { class: 'eyebrow', text: `Attending and known by your community (${known.length})` }),
            known.slice(0, 10).map((r) => h('div', { class: 'line' },
              h('b', { text: `${r.a.first} ${r.a.last}` }),
              h('span', { class: 'muted grow', text: [r.a.position, r.a.company].filter(Boolean).join(' · ') + (r.a.city ? ` · from ${r.a.city}` : '') }),
              h('span', { class: 'badge' + (r.person.owners.length > 1 ? ' strong' : ''), text: 'Known by ' + r.person.owners.map((o) => this.ownerShort(o)).join(' + ') })))) : (this.people().length ? '' : h('p', { class: 'empty', text: 'Add networks above to see who in your community knows the people attending.' })));
        this._evt = { canvas, ev, evs, m, map };
        this.kickEvt();
      }
      stopEvt() { cancelAnimationFrame(this._evtRaf || 0); this._evtRaf = 0; if (this._evtRo) { this._evtRo.disconnect(); this._evtRo = null; } }
      kickEvt() {
        const d = this._evt;
        if (!d || !this.evtOn() || !d.canvas.isConnected) return;
        cancelAnimationFrame(this._evtRaf || 0);
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        for (const b of this.root.querySelectorAll('#panel-event .insight b[data-to]')) countUp(b, Number(b.dataset.to), reduce ? 0 : 1400);
        const draw = eventPainter(this, d);
        if (this._evtRo) this._evtRo.disconnect();
        if (typeof ResizeObserver === 'function') { this._evtRo = new ResizeObserver(() => draw(this._te || 0)); this._evtRo.observe(d.canvas); }
        if (reduce) { this._te = 99; draw(99); return; }
        const t0 = performance.now();
        const loop = (now) => {
          if (!d.canvas.isConnected || !this.evtOn()) { this._evtRaf = 0; return; }
          this._te = (now - t0) / 1000; draw(this._te);
          this._evtRaf = requestAnimationFrame(loop);
        };
        this._evtRaf = requestAnimationFrame(loop);
      }

      dueFollowUps() {
        const today = this.today();
        return Object.entries(this.recs()).filter(([, r]) => stateOf(r, today, { followUpDays: this._cfg.followUpDays }) === 'followup');
      }

      ctx() {
        const base = { outreach: this.recs(), today: this.today(), followUpDays: this._cfg.followUpDays, colleagueDays: this._cfg.colleagueDays };
        const ev = this.currentEvent();
        if (ev && this.eventInTown(ev)) { base.attending = matchEvent(ev, this.people()).attendingKeys; base.eventName = ev.name; }
        return base;
      }
      // ---- events ----
      events() {
        const extra = this.s.attendees || {};
        const place = (o) => { if (o.lat != null && o.lon != null) return o; const ll = geocode(o.city); return ll ? { ...o, lat: ll[0], lon: ll[1] } : { ...o, lat: null, lon: null }; };
        return [...(this._cfg.events || [])].map((e) => {
          const add = extra[e.id];
          return place({ ...e, attendees: [...(e.attendees || []), ...(add ? add.rows : [])].map(place), source: add ? add.source : e.source, invented: add ? false : e.invented });
        }).sort((a, b) => a.start.localeCompare(b.start));
      }
      eventInTown(ev) {
        const st = this.s.settings;
        if (st.mode === 'find') return !!ev && st.event === ev.id;   // "a CTO attending Slush": only an event the prompt named
        return !!st.place && fold(st.place) === fold(ev.city);
      }
      currentEvent() {
        const evs = this.events(), st = this.s.settings;
        return evs.find((e) => e.id === st.event) || evs.find((e) => this.eventInTown(e)) || evs[0] || null;
      }
      eventLine(ev) {
        if (!this.people().length || !(ev.attendees || []).length) return '';   // no list yet: nothing to report
        const m = matchEvent(ev, this.people());
        return `→ ${ev.name} · ${ev.city} · ${eventDates(ev)}: ${m.known.length} of ${ev.attendees.length} attending known by your community · ${m.companies} companies where someone knows someone`;
      }


      renderResults() {
        const box = this.root.getElementById('results');
        if (!box) return;
        const c = this._cfg, topic = this.topic();
        const due = this.dueFollowUps().length;
        this.root.getElementById('banner').replaceChildren(due ? h('p', { class: 'banner' }, `${due} follow-up${due > 1 ? 's' : ''} due. `, h('button', { type: 'button', class: 'link', text: 'Open Outreach', onclick: () => { this.tab = 'track'; this.renderTabs(); } })) : '');
        const people = this.people();
        if (!people.length) return box.replaceChildren(h('p', { class: 'empty', text: 'Add a Connections.csv above to see who in your network fits.' }));
        if (topic.custom && !topic.rule.title && !topic.rule.org) return box.replaceChildren(h('p', { class: 'empty', text: 'Type a job title or a company keyword to search your connections.' }));
        const tables = seatTables(topic.founders, c.tableSize);
        const rctx = this.ctx(), scope = this.s.settings.scope === 'event' && rctx.attending ? 'event' : 'all';
        let ranked = rank(people, topic, rctx);
        if (scope === 'event') ranked = ranked.filter((r) => rctx.attending.has(r.p.key));
        const setScope = (v) => () => { this.s.settings.scope = v; this.save(); this.renderResults(); };
        const seg = false && h('div', { class: 'seg', role: 'group', 'aria-label': 'Who to include' },
          h('button', { type: 'button', class: 'segb', 'aria-pressed': String(scope === 'all'), onclick: setScope('all'), text: 'Everyone' }),
          h('button', { type: 'button', class: 'segb', 'aria-pressed': String(scope === 'event'), onclick: setScope('event'), text: `Only attending ${rctx.eventName}` })) || '';
        const nGuests = Math.min(topic.founders.length || !c.simple ? tables.length : 3, ranked.length);
        const summary = c.simple ? ''  : h('p', { class: 'muted', text: topic.founders.length
          ? `${tables.length} table${tables.length > 1 ? 's' : ''} of founders working on ${topic.topic}. ${ranked.length} ${ranked.length === 1 ? 'person' : 'people'} in your networks fit.`
          : `${ranked.length} ${ranked.length === 1 ? 'person' : 'people'} in your networks fit.` });
        if (!ranked.length) return box.replaceChildren(seg, summary, h('p', { class: 'empty', text: 'No one new fits. People you have already contacted are in Outreach; add another network above to widen the search.' }));
        const cards = h('div', { class: 'cards' }, ranked.slice(0, nGuests).map((r, i) => this.card(r, tables[i % tables.length], topic.founders.length ? `Table ${i + 1} guest` : 'Guest', true)));
        const rest = c.simple ? [] : ranked.slice(nGuests, nGuests + 12);
        box.replaceChildren(seg, summary, cards, rest.length ? h('div', { class: 'more' },
          h('span', { class: 'eyebrow', text: `Also fits (${ranked.length - nGuests})` }),
          rest.map((r, i) => {
            const k = this.cardKey(r.p, 'direct');
            if (this.open.has(k)) return h('div', { class: 'cards' }, this.card(r, tables[(nGuests + i) % tables.length], 'Backup', true));
            return h('div', { class: 'line' }, h('b', { text: `${r.p.first} ${r.p.last}` }), h('span', { class: 'muted grow', text: [r.p.position, r.p.company].filter(Boolean).join(' · ') + (r.note ? ` · ${r.note}` : '') }),
              h('span', { class: 'badge' + (r.f.strong ? ' strong' : ''), text: r.f.strong ? 'Strong' : 'Possible' }),
              h('button', { type: 'button', class: 'btn ghost small', text: 'Draft', onclick: () => { this.open.add(k); this.renderResults(); } }));
          })) : '');
      }

      cardKey(p, kind) { return [this.eventId, this.s.settings.topic, p.key, kind].join('|'); }

      ownerOf(p) { return p.owners.find((o) => !o.me) || p.owners[0]; }
      kindOf(p) { return p.owners.some((o) => o.me) ? 'direct' : 'intro'; }

      /** One person with an editable message and the send flow. `rec` is passed for tracker follow-ups. */
      card({ p, f, note }, table, label, fresh, follow) {
        const base = follow ? follow.kind : this.kindOf(p);
        const kind = follow ? 'follow_up' : base;
        const owner = base === 'intro' ? this.ownerOf(p) : null;
        const st = this.s.settings;
        const key = this.cardKey(p, kind);
        const generate = () => draft({ kind, base, person: p, owner, table, topic: this.topic(), date: st.date, place: st.place, signature: st.signature, eventWord: st.eventWord, event: (() => { const ev = this.currentEvent(); return ev && this.eventInTown(ev) ? ev.name : ''; })() });
        const text = this.drafts.has(key) ? this.drafts.get(key) : generate();
        const area = h('textarea', { class: 'draft', 'aria-label': `Message to ${base === 'intro' && owner ? owner.name : p.first}`, value: text });
        const count = h('span'), problems = h('div', { class: 'problem', 'aria-live': 'polite' });
        const refresh = () => { count.textContent = `${area.value.length}/${MAX_CHARS}`; problems.replaceChildren(...voiceProblems(area.value).map((x) => h('div', { text: x }))); };
        area.addEventListener('input', () => { this.drafts.set(key, area.value); refresh(); });
        refresh();

        const target = base === 'intro' ? (owner && owner.url) : p.url; // whose LinkedIn page to open
        const targetName = base === 'intro' ? (owner ? owner.name : 'them') : p.first;
        const send = async () => {
          const copied = copyText(area.value);          // before opening a tab: the page must still have focus
          if (target) window.open(target, '_blank', 'noopener');
          const ok = await copied;
          if (!ok || !this._cfg.simple) this.toast(ok ? 'Message copied.' : 'Could not copy automatically: select the message and copy it.');
          this.pending.add(key); this.renderResults(); this.renderTracker();
        };
        const confirmed = () => {
          const today = this.today();
          const prev = this.recs()[p.key];
          const rec = { status: 'sent', at: today, kind: base, topic: st.topic, name: `${p.first} ${p.last}`.trim(), position: p.position, company: p.company, ck: companyKey(p.company), url: p.url, sends: (prev && prev.sends || 0) + 1, sample: p.sample || undefined };
          this.pending.delete(key); this.drafts.delete(key);
          this.emit('sent', { person: p.key, kind: follow ? 'follow_up' : base, topic: st.topic, event: this.eventId, at: today });
          this.setRec(p.key, rec);
        };
        const status = (s, extra) => () => {
          const prev = this.recs()[p.key] || {};
          this.emit('status', { person: p.key, status: s, event: this.eventId });
          this.setRec(p.key, { ...prev, name: `${p.first} ${p.last}`.trim(), position: p.position, company: p.company, ck: companyKey(p.company), url: p.url, kind: base, topic: st.topic, ...(prev.at ? {} : { at: this.today() }), ...extra, status: s, sample: p.sample || undefined });
        };

        const sendLabel = target ? (base === 'intro' ? `Copy & open ${targetName} on LinkedIn` : 'Copy & open on LinkedIn') : 'Copy message';
        const via = this.ownerLabel(p);
        return h('article', { class: 'card' },
          h('div', { class: 'card-head' },
            label && !this._cfg.simple && h('span', { class: 'eyebrow', style: 'color:var(--ft-accent)', text: label }),
            h('b', null, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener', text: `${p.first} ${p.last}` }) : `${p.first} ${p.last}`),
            f && !this._cfg.simple && h('span', { class: 'badge' + (f.strong ? ' strong' : ''), text: f.strong ? 'Strong' : 'Possible' }),
            p.sample && h('span', { class: 'badge plain', text: 'invented' })),
          h('span', { class: 'meta', text: [p.position, p.company].filter(Boolean).join(' · ') + (f && !this._cfg.simple ? `. ${f.why[0].toUpperCase() + f.why.slice(1)}.` : '') }),
          this._cfg.simple && !follow ? h('div', { class: 'tags' }, h('span', { class: 'tag hot', text: 'Known by ' + p.owners.map((o) => this.ownerShort(o)).join(' + ') }), note && !/^Colleague/.test(note) && h('span', { class: 'tag', text: note.replace(/ · Colleague.*/, '') }))
            : f && h('span', { class: 'meta', text: `Matched on ${f.on} · in ${via}` + (note ? ` · ${note}` : '') }),
          !this._cfg.simple && h('span', { class: 'eyebrow', text: follow ? 'Follow-up' : base === 'intro' ? `Ask ${owner ? owner.name : 'the person who knows them'} for an intro` : 'Invite' }),
          area, this._cfg.simple ? null : h('div', { class: 'draft-foot' }, count, h('button', { type: 'button', class: 'link', text: 'Reset text', onclick: () => { this.drafts.delete(key); area.value = generate(); refresh(); } })), problems,
          this.pending.has(key)
            ? h('div', { class: 'confirm' }, h('span', { text: this._cfg.simple ? 'Copied. Send it on LinkedIn, then mark it here.' : `Copied. Paste it into ${base === 'intro' ? targetName + "'s" : 'the'} message box on LinkedIn and press send, then confirm here.` }),
              h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn small', text: this._cfg.simple ? 'Sent' : 'I sent it', onclick: confirmed }), h('button', { type: 'button', class: 'btn quiet small', text: this._cfg.simple ? 'Undo' : 'Not sent', onclick: () => { this.pending.delete(key); this.renderResults(); this.renderTracker(); } })))
            : h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'btn small', text: sendLabel, onclick: send }),
              !follow && !this._cfg.simple && h('button', { type: 'button', class: 'btn quiet small', text: `Skip ${this._cfg.snoozeDays} days`, onclick: status('snoozed', { until: core.addDays(this.today(), this._cfg.snoozeDays) }) }),
              !follow && !this._cfg.simple && h('button', { type: 'button', class: 'btn quiet small', text: 'Not a fit', onclick: status('not_fit') })));
      }

      ownerLabel(p) {
        return p.owners.map((o) => (o.me ? (o.name === 'Me' || o.sample ? 'your network' : o.name + "'s network") : `${o.name}'s network${o.role ? ' (' + o.role + ')' : ''}`)).filter((v, i, a) => a.indexOf(v) === i).join(' + ');
      }

      renderTracker() {
        const box = this.root.getElementById('panel-track');
        if (!box) return;
        const recs = Object.entries(this.recs());
        if (!recs.length) return box.replaceChildren(h('p', { class: 'empty', text: 'Nothing sent yet. People you invite show up here, with a follow-up reminder after a week without a reply.' }));
        const today = this.today(), fu = this._cfg.followUpDays;
        const groups = [['followup', 'Follow-up due'], ['waiting', 'Waiting for a reply'], ['meeting', 'Meeting or yes'], ['replied', 'Replied'], ['snoozed', 'Skipped for now'], ['not_fit', 'Not a fit']];
        const people = new Map(this.people().map((p) => [p.key, p]));
        const out = [];
        for (const [state, title] of groups) {
          const rows = recs.filter(([, r]) => stateOf(r, today, { followUpDays: fu }) === state).sort((a, b) => b[1].at.localeCompare(a[1].at));
          if (!rows.length) continue;
          out.push(h('div', { class: 'more' }, h('span', { class: 'eyebrow', text: `${title} (${rows.length})` }), rows.map(([key, r]) => this.trackerRow(key, r, state, people.get(key)))));
        }
        box.replaceChildren(...out, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn quiet small', text: 'Download as CSV', onclick: () => this.downloadCsv() })));
      }

      trackerRow(key, r, state, person) {
        const p = person || { key, first: r.name.split(' ')[0], last: r.name.split(' ').slice(1).join(' '), url: r.url || '', company: r.company, position: r.position, owners: [], sample: !!r.sample };
        const set = (s, extra) => () => { this.emit('status', { person: key, status: s, event: this.eventId }); this.setRec(key, { ...r, ...extra, status: s }); };
        const label = { followup: `Sent ${shortDate(r.at)}, no reply`, waiting: `Sent ${shortDate(r.at)}`, meeting: 'Meeting booked', replied: 'Replied', snoozed: `Back on ${r.until ? shortDate(r.until) : '—'}`, not_fit: 'Not a fit' }[state];
        const fuKey = this.cardKey(p, 'follow_up');
        const line = h('div', { class: 'line' },
          h('b', null, r.url ? h('a', { href: safeProfileUrl(r.url) || undefined, target: '_blank', rel: 'noopener', text: r.name, style: 'color:inherit' }) : r.name),
          h('span', { class: 'muted grow', text: [r.position, r.company].filter(Boolean).join(' · ') }),
          h('span', { class: 'badge' + (state === 'followup' ? ' due' : ' plain'), text: label }),
          (state === 'followup' || state === 'waiting') && h('button', { type: 'button', class: 'btn ghost small', text: 'Replied', onclick: set('replied') }),
          (state === 'followup' || state === 'waiting' || state === 'replied') && h('button', { type: 'button', class: 'btn ghost small', text: 'Meeting booked', onclick: set('meeting') }),
          (state === 'followup' || state === 'waiting') && h('button', { type: 'button', class: 'btn quiet small', text: 'Not a fit', onclick: set('not_fit') }),
          state === 'followup' && h('button', { type: 'button', class: 'btn small', text: this.open.has(fuKey) ? 'Hide follow-up' : 'Draft follow-up', onclick: () => { this.open.has(fuKey) ? this.open.delete(fuKey) : this.open.add(fuKey); this.renderTracker(); } }),
          (state === 'snoozed' || state === 'not_fit') && h('button', { type: 'button', class: 'btn quiet small', text: 'Bring back', onclick: () => this.setRec(key, null) }));
        if (state !== 'followup' || !this.open.has(fuKey)) return line;
        const topic = this._cfg.topics.find((t) => t.key === r.topic) || this.topic();
        const tables = seatTables(topic.founders, this._cfg.tableSize);
        const owner = (r.kind === 'intro' && person) ? this.ownerOf(person) : null;
        const pp = person || p; if (r.kind === 'intro' && !pp.owners.length) pp.owners = [];
        return h('div', null, line, h('div', { class: 'cards' }, this.card({ p: pp, f: null, note: '' }, tables[0], '', false, { kind: r.kind || 'direct', owner })));
      }

      downloadCsv() {
        const rows = [['Name', 'Position', 'Company', 'LinkedIn', 'Status', 'Last contact', 'Messages sent']].concat(Object.values(this.recs()).map((r) => [r.name, r.position, r.company, r.url, r.status, r.at || '', r.sends || 0]));
        const esc = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        const url = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' }));
        const a = h('a', { href: url, download: `outreach-${this.eventId}.csv` });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
    customElements.define('founder-tables-outreach', FounderTablesOutreach);
  }

  /** Copies text. Returns a promise of true/false. Call it synchronously from a click handler. */
  function copyText(text) {
    const fallback = () => {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
    return Promise.resolve(fallback());
  }

  return { version: '0.1.0', core, define };
});
