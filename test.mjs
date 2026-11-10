// node test.mjs: tests for the pure core (parser, merge, fit, rank, statuses, prompt, drafts).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { core } = require('./founder-tables-outreach.js');
globalThis.window = {};
require('./examples/config.js');
const cfg = globalThis.window.FT_EXAMPLE_CONFIG;
const topics = cfg.topics.map(core.compileTopic);
const t = (k) => topics.find((x) => x.key === k);

let n = 0;
const test = (name, fn) => { try { fn(); n++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n', e.message); process.exitCode = 1; } };

// ---- parser ----
const sample = readFileSync(new URL('./sample-connections.csv', import.meta.url), 'utf8');
test('parses LinkedIn export with Notes preamble, quotes and no email read', () => {
  const { rows, report } = core.parseConnections(sample);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].last, 'Name, Jr');
  assert.equal(rows[1].company, 'Big "Cement" Co');
  assert.ok(!JSON.stringify(rows).includes('test@example.com'), 'email must not be kept');
  assert.ok(report.warnings.some((w) => /no profile URL/.test(w)));
});
test('rejects a file that is not Connections.csv', () => {
  assert.match(core.parseConnections('a,b\n1,2').report.error, /Connections\.csv/);
});
test('handles BOM, semicolons, reordered columns, CRLF', () => {
  const csv = '﻿"Position";"Company";"Last Name";"First Name";"URL"\r\nHead of Procurement;Acme Steel;Person;Test;https://www.linkedin.com/in/test-person\r\n';
  const { rows } = core.parseConnections(csv);
  assert.deepEqual(rows[0], { first: 'Test', last: 'Person', url: 'https://www.linkedin.com/in/test-person', company: 'Acme Steel', position: 'Head of Procurement' });
});

// ---- identity ----
test('profileKey normalises; only linkedin /in/ urls are linkable', () => {
  assert.equal(core.profileKey('https://www.linkedin.com/in/Some-Name/?x=1'), 'linkedin.com/in/some-name');
  assert.equal(core.safeProfileUrl('javascript:alert(1)'), '');
  assert.equal(core.safeProfileUrl('https://evil.example/in/x'), '');
});
test('people merge by profile URL only, never by name', () => {
  const a = { id: 'a', name: 'A', me: true, rows: [{ first: 'Sam', last: 'Lee', url: 'https://www.linkedin.com/in/sam-lee', company: 'X', position: 'CTO' }, { first: 'Kim', last: 'Ho', url: '', company: 'Y', position: 'CTO' }] };
  const b = { id: 'b', name: 'B', me: false, rows: [{ first: 'Sam', last: 'Lee', url: 'https://linkedin.com/in/Sam-Lee/', company: 'X', position: 'CTO' }, { first: 'Kim', last: 'Ho', url: '', company: 'Y', position: 'CTO' }] };
  const people = core.mergePeople([a, b]);
  assert.equal(people.length, 3);
  assert.equal(people.find((p) => p.first === 'Sam').owners.length, 2);
});

// ---- fit and rank ----
const mk = (first, position, company, ...owners) => ({ key: first, first, last: 'X', url: '', position, company, owners, sample: false });
const me = { id: 'me', name: 'Me', me: true, rows: [] }, alex = { id: 'al', name: 'Alex', me: false, rows: [] };
test('students and interns are never a fit', () => {
  assert.equal(core.fitFor(mk('A', 'Procurement Intern', 'Nordhavn Steel', me), t('industrial')), null);
  assert.equal(core.fitFor(mk('A', 'Student', 'Steel University', me), t('industrial')), null);
});
test('title + company is strong, and says what it matched on', () => {
  const f = core.fitFor(mk('A', 'Head of Procurement', 'Nordhavn Steel', me), t('industrial'));
  assert.equal(f.strong, true);
  assert.match(f.on, /procurement/);
  assert.match(f.on, /Steel/);
});
test('one per company; a recently contacted colleague ranks the rest lower and says so', () => {
  const ppl = [mk('A', 'Head of Procurement', 'Kalkvik Cement Oy', me), mk('B', 'Plant Manager', 'Kalkvik Cement', me), mk('C', 'Head of Procurement', 'Other Steel AB', me)];
  const r1 = core.rank(ppl, t('industrial'), { today: '2026-11-10' });
  assert.equal(r1.length, 2, 'Oy suffix must not split a company');
  const outreach = { Z: { status: 'sent', at: '2026-11-05', ck: core.companyKey('Kalkvik Cement') } };
  const r2 = core.rank(ppl, t('industrial'), { outreach, today: '2026-11-10' });
  assert.equal(r2[0].p.first, 'C');
  assert.match(r2[1].note, /Colleague contacted 5 Nov/);
});
test('status rules: sent hidden, follow-up after 7 days, replied never again, snooze returns', () => {
  const today = '2026-11-10';
  assert.equal(core.stateOf(undefined, today), 'new');
  assert.equal(core.stateOf({ status: 'sent', at: '2026-11-05' }, today), 'waiting');
  assert.equal(core.stateOf({ status: 'sent', at: '2026-11-03' }, today), 'followup');
  assert.equal(core.stateOf({ status: 'replied', at: '2026-01-01' }, today), 'replied');
  assert.equal(core.stateOf({ status: 'snoozed', at: '2026-11-01', until: '2026-12-01' }, today), 'snoozed');
  assert.equal(core.stateOf({ status: 'snoozed', at: '2026-08-01', until: '2026-11-09' }, today), 'new');
  const ppl = [mk('A', 'Head of Procurement', 'Nordhavn Steel', me)];
  for (const status of ['sent', 'replied', 'meeting', 'not_fit']) {
    assert.equal(core.rank(ppl, t('industrial'), { outreach: { A: { status, at: '2026-11-09', ck: 'x' } }, today }).length, 0, status);
  }
});
test('tables mix groups and use every founder once', () => {
  const f = [['Kvanta Steel', 'a'], ['Lumo Grid', 'b'], ['Velo Cement', 'a'], ['Arro Mining', 'c'], ['Brisa Hydrogen', 'b'], ['Tolva Robotics', 'c'], ['Nexo Wind', 'a'], ['Fyra Batteries', 'b'], ['Odin Recycling', 'c'], ['Mira Solar', 'a'], ['Helo Materials', 'b'], ['Ulma Logistics', 'c']].map(([name, group]) => ({ name, group }));
  const tables = core.seatTables(f, 6);
  assert.equal(tables.flat().length, f.length);
  assert.ok(tables.every((tb) => new Set(tb.map((x) => x.group)).size > 1));
});

// ---- events ----
test('event attendees match people by profile URL only; companies match by name', () => {
  const sam = { id: 's', name: 'Sam', me: false, rows: [{ first: 'Ida', last: 'Lund', url: 'https://www.linkedin.com/in/demo-1', company: 'Nordhavn Steel Oy', position: 'Head of Energy' }, { first: 'Kai', last: 'Moe', url: 'https://www.linkedin.com/in/demo-2', company: 'Kalkvik Cement', position: 'Plant Manager' }] };
  const people = core.mergePeople([sam]);
  const ev = { id: 'e', name: 'Summit', attendees: [
    { first: 'Ida', last: 'Lund', url: 'https://linkedin.com/in/Demo-1/', company: 'Nordhavn Steel', position: 'Head of Energy' },   // same URL: known
    { first: 'Ida', last: 'Lund', url: '', company: 'Elsewhere AB', position: 'CTO' },                                                // same NAME, no URL: never merged
    { first: 'Joe', last: 'Roe', url: 'https://www.linkedin.com/in/demo-9', company: 'Kalkvik Cement AB', position: 'Buyer' },       // not known, but a colleague of Kai
  ] };
  const m = core.matchEvent(ev, people);
  assert.equal(m.known.length, 1);
  assert.equal(m.rows[1].person, null, 'a name alone never merges');
  assert.equal(m.rows[2].colleagues.length, 1);
  assert.equal(m.companies, 2, 'Nordhavn Steel and Kalkvik Cement');
  assert.deepEqual([...m.attendingKeys], ['linkedin.com/in/demo-1']);
});
test('attending the event in the dinner city ranks a person higher and says why', () => {
  const a = mk('A', 'Head of Procurement', 'Alpha Steel', me), b = mk('B', 'Head of Procurement', 'Beta Steel', me);
  const base = core.rank([a, b], t('industrial'), { today: '2026-11-10' });
  const boosted = core.rank([a, b], t('industrial'), { today: '2026-11-10', attending: new Set(['B']), eventName: 'Example Industry Summit' });
  assert.equal(base[0].p.first, 'A');
  assert.equal(boosted[0].p.first, 'B');
  assert.match(boosted[0].note, /Attending Example Industry Summit/);
});
test('event dates read plainly', () => {
  assert.equal(core.eventDates({ start: '2026-12-03', end: '2026-12-04' }), '3–4 Dec');
  assert.equal(core.eventDates({ start: '2027-01-21', end: '2027-01-21' }), '21 Jan');
  assert.equal(core.longDate('2026-12-03'), 'Thursday 3 December');
});

// ---- prompt ----
test('"make me a dinner in oslo for sustainable industry people"', () => {
  const p = core.interpretPrompt('make me a dinner in oslo for sustainable industry people', topics);
  assert.equal(p.eventWord, 'dinner');
  assert.equal(p.place, 'Oslo');
  assert.equal(p.theme, 'sustainable industry');
  assert.equal(p.topicKey, 'industrial');
});
test('other prompts: lunch, date, AI, unknown theme falls back to keywords', () => {
  const a = core.interpretPrompt('a lunch in stockholm on Thursday 4 December for AI founders', topics);
  assert.deepEqual([a.eventWord, a.place, a.date, a.topicKey], ['lunch', 'Stockholm', 'Thursday 4 December', 'ai']);
  const b = core.interpretPrompt('dinner in Helsinki for shipping people', topics);
  assert.equal(b.topicKey, 'custom');
  assert.match(b.custom.title, /shippi/);
  assert.equal(core.interpretPrompt('', topics).topicKey, '');
});
test('custom topic matches on word starts and escapes regex characters', () => {
  const c = core.customTopic({ title: 'shippi, (', org: 'port', topic: 'shipping' });
  assert.ok(core.fitFor(mk('A', 'Head of Shipping', 'Harbour', me), c));
  assert.equal(core.fitFor(mk('A', 'Sales', 'Passport Co', me), c), null, 'word start only');
});

test('an event named in the prompt sets city, dates and the default topic', () => {
  const events = [{ id: 'is', name: 'Example Industry Summit', city: 'Stockholm', start: '2026-12-03', end: '2026-12-04', attendees: [] }, { id: 'fd', name: 'Nordic Founder Day', city: 'Helsinki', start: '2027-01-21', attendees: [] }];
  const withDefault = [core.compileTopic({ key: 'founders', label: 'Founders', default: true, plain: true, match: { title: /founder|\bceo\b/i, req: 'title' } }), ...topics];
  const p = core.interpretPrompt("plan a founder dinner for the example industry summit in stockholm", withDefault, events);
  assert.equal(p.eventId, 'is');
  assert.equal(p.place, 'Stockholm');
  assert.equal(p.eventWord, 'founder dinner');
  assert.equal(p.topicKey, 'founders', '"industry" names the event, not the guests');
  // a theme that is not the event's own words still wins
  assert.equal(core.interpretPrompt("a dinner for AI founders at the example industry summit", withDefault, events).topicKey, 'ai');
});

// ---- messages ----
test('"an energy field founder dinner": founders whose company is in the energy field', () => {
  const events = [{ id: 'is', name: 'Example Industry Summit', city: 'Stockholm', start: '2026-12-03', attendees: [] }];
  const grid = core.compileTopic({ key: 'grid', label: 'Working with utilities & the grid', keywords: ['energy', 'utilities', 'grid', 'power', 'hydrogen', 'batteries'], match: { title: /grid|energy/i, req: 'any' } });
  const dflt = core.compileTopic({ key: 'founders', label: 'Founders', default: true, plain: true, keywords: ['founder'], match: { title: /founder|\bceo\b/i, req: 'title' } });
  const p = core.interpretPrompt("plan an energy field founder dinner for the example industry summit", [dflt, grid], events);
  assert.equal(p.topicKey, 'founders');
  assert.equal(p.eventWord, 'founder dinner');
  assert.equal(p.place, 'Stockholm');
  assert.ok(p.field && p.field.org.includes('energy') && p.field.org.includes('hydrogen'), 'field keywords from the energy topic');
  assert.equal(p.field.label, 'energy');
});
test('plain topics draft a short event invite with the event named', () => {
  const plain = core.compileTopic({ key: 'founders', label: 'Founders', plain: true, match: { title: /founder/i, req: 'title' } });
  const p = mk('Aino', 'Founder & CEO', 'Paxova Steel', me); p.last = 'Weiss';
  const base = { person: p, topic: plain, date: 'Thursday 3 December', place: 'Stockholm', signature: '– Sam', eventWord: 'founder dinner', event: 'Example Industry Summit' };
  const d = core.draft({ ...base, kind: 'direct' });
  assert.equal(d, "Hi Aino,\n\nWe're hosting a small founder dinner in Stockholm on Thursday 3 December, during Example Industry Summit.\n\nWould you join us?\n\n– Sam");
  assert.match(core.draft({ ...base, kind: 'intro', owner: alex }), /^Hi Alex,\n\nCould you introduce me to Aino Weiss at Paxova Steel\?/);
  assert.deepEqual(core.voiceProblems(d), []);
});
test('drafts: direct, intro, follow-up; use only given facts; stay within the rules', () => {
  const p = mk('Ingrid', 'Head of Procurement', 'Nordhavn Steel', me); p.last = 'Sjöberg';
  const table = [{ name: 'Kvanta Steel' }, { name: 'Lumo Grid' }, { name: 'Velo Cement' }, { name: 'Arro Mining' }];
  const base = { person: p, table, topic: t('industrial'), date: 'Thursday 4 December', place: 'Oslo', signature: '– Sam', eventWord: 'dinner' };
  const d = core.draft({ ...base, kind: 'direct' });
  assert.match(d, /^Hi Ingrid,/);
  assert.match(d, /small dinner in Oslo on Thursday 4 December: 4 founders working on selling to heavy industry, including Kvanta Steel, Lumo Grid and Velo Cement/);
  assert.match(d, /– Sam$/);
  const i = core.draft({ ...base, kind: 'intro', owner: alex });
  assert.match(i, /^Hi Alex,/);
  assert.match(i, /introduce me to Ingrid Sjöberg at Nordhavn Steel/);
  for (const text of [d, i, core.draft({ ...base, kind: 'follow_up' })]) assert.deepEqual(core.voiceProblems(text), []);
  assert.ok(core.voiceProblems('We matched on your title, score 9').length);
  assert.ok(core.voiceProblems('x'.repeat(501)).length);
  const bare = core.draft({ kind: 'direct', person: mk('A', '', '', me), topic: t('ai') });
  assert.ok(!/undefined|null|\{/.test(bare));
});

// ---- storage ----
test('serialize drops samples, keeps rows compact, round-trips, and never holds an email field', () => {
  const s = core.emptyState();
  s.networks = [{ id: 'n1', name: 'Me', me: true, rows: [{ first: 'A', last: 'B', url: '', company: 'C', position: 'D' }] }, { id: 's', name: 'S', sample: true, rows: [] }];
  s.outreach.ev = { k: { status: 'sent', at: '2026-11-01' }, z: { status: 'sent', at: '2026-11-01', sample: true } };
  const data = core.serialize(s);
  assert.equal(data.networks.length, 1);
  assert.equal(Object.keys(data.outreach.ev).length, 1);
  assert.ok(!/email/i.test(JSON.stringify(data)));
  const back = core.deserialize(JSON.parse(JSON.stringify(data)));
  assert.equal(back.networks[0].rows[0].company, 'C');
  assert.equal(core.deserialize(null).networks.length, 0);
});

console.log(`\n${n} tests passed${process.exitCode ? ', with failures' : ''}`);
