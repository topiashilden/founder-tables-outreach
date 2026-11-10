// LinkedIn's Member Snapshot API, CONNECTIONS, against hand-made pages of the documented response shape (ported from
// warm-paths). Every person is invented; the token is fake and no request leaves this process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fetchConnections, toConnections, toCsv, coverageLines, DmaError, DMA_VERSION } from '../lib/linkedin-dma.mjs';
const { core } = createRequire(import.meta.url)('../founder-tables-outreach.js');

const TOKEN = 'fake-token-for-tests-0000';
const fx = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
function fake(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = replies.shift() ?? { status: 404, body: fx('dma-no-data.json') };
    return { status: r.status, headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body };
  };
  return { fetch, calls };
}
const noWait = async () => {};

test('pages through CONNECTIONS until "No data found", with the version the docs require', async () => {
  const f = fake([{ status: 200, body: fx('dma-connections-page-0.json') }, { status: 200, body: fx('dma-connections-page-1.json') }, { status: 404, body: fx('dma-no-data.json') }]);
  const r = await fetchConnections({ token: TOKEN, fetch: f.fetch, sleep: noWait });
  assert.equal(r.rows.length, 4);
  assert.equal(r.pages, 2);
  assert.deepEqual(f.calls.map((c) => c.url), [0, 1, 2].map((s) => `https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=CONNECTIONS&start=${s}`));
  for (const c of f.calls) { assert.equal(c.headers['Linkedin-Version'], DMA_VERSION); assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`); }
  assert.equal(DMA_VERSION, '202312');
});

test('retries 429 and 5xx politely, stops on 401 with a message that never holds the token', async () => {
  const waits = [];
  const f = fake([{ status: 429, body: '', headers: { 'retry-after': '3' } }, { status: 503, body: 'busy' }, { status: 200, body: fx('dma-connections-page-1.json') }, { status: 404, body: fx('dma-no-data.json') }]);
  const r = await fetchConnections({ token: TOKEN, fetch: f.fetch, sleep: async (ms) => void waits.push(ms) });
  assert.equal(r.rows.length, 1);
  assert.equal(r.retries, 2);
  assert.equal(waits[0], 3000);
  const expired = fake([{ status: 401, body: '{"message":"Invalid access token"}' }]);
  await assert.rejects(fetchConnections({ token: TOKEN, fetch: expired.fetch, sleep: noWait }), (e) => e instanceof DmaError && e.status === 401 && /expired or been revoked/.test(e.message) && !e.message.includes(TOKEN));
  assert.equal(expired.calls.length, 1, 'no retry on 401');
  const always = fake(Array.from({ length: 10 }, () => ({ status: 500, body: 'down' })));
  await assert.rejects(fetchConnections({ token: TOKEN, fetch: always.fetch, sleep: noWait }), /kept answering 500/);
  assert.equal(always.calls.length, 6);
  await assert.rejects(fetchConnections({ token: TOKEN, fetch: fake([{ status: 404, body: fx('dma-no-data.json') }]).fetch, sleep: noWait }), /no CONNECTIONS snapshot/);
  await assert.rejects(fetchConnections({ token: TOKEN, fetch: fake([{ status: 403, body: 'nope' }]).fetch, sleep: noWait }), /EEA or Switzerland/);
});

test('rows become a Connections.csv without emails that the widget parser reads as an export', () => {
  const pages = [fx('dma-connections-page-0.json'), fx('dma-connections-page-1.json')].map((b) => JSON.parse(b).elements[0].snapshotData).flat();
  const { connections, coverage } = toConnections(pages);
  assert.deepEqual([coverage.rows, coverage.url, coverage.profileUrl, coverage.emailsDropped, coverage.otherKeys], [4, 3, 3, 1, ['Note']]);
  const csv = toCsv(connections);
  assert.ok(!/@|Email/.test(csv), 'no email anywhere');
  const { rows, report } = core.parseConnections(csv);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].company, 'Testilogistiikka Oy, Vantaa');
  assert.equal(rows[1].position, 'Head of Logistics, "Lean"');
  assert.ok(report.warnings.some((w) => /no profile URL/.test(w)));
  const lines = coverageLines(coverage).join('\n');
  for (const p of pages) for (const v of Object.values(p)) if (String(v).length > 3) assert.ok(!lines.includes(String(v)), `printed a value: ${v}`);
});

test('overlapping pages are kept once per person (people, not rows)', async () => {
  const [a, b, noUrl] = JSON.parse(fx('dma-connections-page-0.json')).elements[0].snapshotData;
  const [d] = JSON.parse(fx('dma-connections-page-1.json')).elements[0].snapshotData;
  const page = (start, rows, last = false) => ({ status: 200, body: JSON.stringify({ paging: { start, links: last ? [] : [{ rel: 'next' }] }, elements: [{ snapshotDomain: 'CONNECTIONS', snapshotData: rows }] }) });
  const f = fake([page(0, [a, b, noUrl]), page(1, [a, b, d]), page(2, [a, { ...b, Position: 'Logistics Director' }, noUrl, d], true), { status: 404, body: fx('dma-no-data.json') }]);
  const r = await fetchConnections({ token: TOKEN, fetch: f.fetch, sleep: noWait });
  const { connections, coverage } = toConnections(r.rows);
  assert.deepEqual([r.rows.length, connections.length, coverage.repeats], [10, 4, 6]);
  assert.equal(connections[1].position, 'Logistics Director', 'the latest page wins');
});
