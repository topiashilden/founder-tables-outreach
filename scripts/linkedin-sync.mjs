// Fetches one member's connections from LinkedIn's Member Data Portability API (EU DMA, CONNECTIONS only) with
// their OWN token, and writes them as a Connections.csv without emails. Prints counts and field coverage only:
// never a name, never the token.
//
//   LINKEDIN_DMA_TOKEN=... node scripts/linkedin-sync.mjs --owner "Alex" --dry-run      fetch and count, write nothing
//   node --env-file=.env.local scripts/linkedin-sync.mjs --owner "Alex"                 write private/Alex-Connections.csv
//   ... --out some/dir                                                                  write somewhere else
//   ... --json                                                                          also write rows as JSON, for el.addNetwork()
//
// Then: attach the CSV in the widget (same button as a LinkedIn export), or have your platform's server send the
// rows to the page and call el.addNetwork({ name, role, rows }). How to get the token: docs/linkedin-data.md
import fs from 'node:fs';
import path from 'node:path';
import { coverageLines, DmaError, fetchConnections, toConnections, toCsv } from '../lib/linkedin-dma.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const value = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
const stop = (msg) => { console.error(msg); process.exit(1); };

const dry = has('--dry-run');
const owner = value('--owner')?.trim();
const outDir = path.resolve(value('--out') || 'private');
const token = process.env.LINKEDIN_DMA_TOKEN?.trim();
if (!token) stop('No LINKEDIN_DMA_TOKEN in the environment. Put it in .env.local and run with node --env-file=.env.local (see docs/linkedin-data.md).');
if (!dry && !owner) stop('Say whose connections these are: --owner "Name".');

console.log(`LinkedIn Member Data Portability API: CONNECTIONS only, Linkedin-Version 202312.${dry ? ' Dry run: nothing is written.' : ` Writing to ${outDir} as "${owner}".`}`);
let fetched;
const pageRows = [];
try {
  fetched = await fetchConnections({ token, onPage: (n, rows) => { pageRows.push(rows); process.stdout.write(`\rPage ${n}: ${rows} rows`); } });
} catch (e) {
  process.stdout.write('\n');
  stop(e instanceof DmaError ? e.message : `Could not reach LinkedIn: ${e instanceof Error ? e.message : String(e)}`);
}
process.stdout.write('\n');
const { connections, coverage } = toConnections(fetched.rows);
console.log(`${fetched.pages} page${fetched.pages === 1 ? '' : 's'}${pageRows.length > 1 ? ` (${pageRows.join(' + ')} rows)` : ''}${fetched.retries ? `, ${fetched.retries} polite retries` : ''}.`);
for (const line of coverageLines(coverage)) console.log(line);
if (dry) { console.log('Dry run: nothing written.'); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true });
const safe = owner.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'owner';
const csvFile = path.join(outDir, `${safe}-Connections.csv`);
fs.writeFileSync(csvFile, toCsv(connections));
console.log(`Wrote ${csvFile}: ${connections.length.toLocaleString('en-US')} connections, no emails.`);
if (has('--json')) {
  const jsonFile = path.join(outDir, `${safe}-connections.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ name: owner, rows: connections.map(({ first, last, url, company, position }) => ({ first, last, url, company, position })) }));
  console.log(`Wrote ${jsonFile} for el.addNetwork().`);
}
console.log('This folder holds personal data: keep it out of git (private/ is ignored).');
