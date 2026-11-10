// Turns text you copied from an event's PUBLIC speaker, partner, exhibitor or startup page into an attendee CSV
// the widget can import (Event map -> "Add the attendee list"). Claude reads the text and returns structured rows.
//
//   node --env-file=.env.local scripts/extract-public-list.mjs speakers.txt --kind speaker --out speakers.csv
//   node --env-file=.env.local scripts/extract-public-list.mjs partners.txt --kind partner >> partners.csv
//   ... --dry-run     show what would be sent, call nothing
//
// What this is and isn't:
// - It does NOT fetch pages or crawl sites. You copy the text of a public page (select all, copy, paste into a .txt
//   file) and point the script at it. That keeps a person in the loop, respects sites that forbid automated access,
//   and never touches pages behind a login (attendee directories in event apps, LinkedIn event attendee lists).
// - Speaker/partner pages are a PARTIAL list: the people on stage and the companies paying for booths, not the
//   thousands of attendees. The complete list only exists with the organiser (an export) or with you (your RSVPs).
// - Claude is told to copy only what the text says. LinkedIn URLs come only from the text (pages often link them);
//   a person without one can only be matched at company level. Check the output before importing it.
// Needs ANTHROPIC_API_KEY (or an `ant auth login` profile). Docs: docs/event-data.md
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const args = process.argv.slice(2);
const value = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
const stop = (msg) => { console.error(msg); process.exit(1); };
const file = args.find((a) => !a.startsWith('--') && a !== value('--kind') && a !== value('--out'));
const kind = value('--kind') || 'speaker';
const out = value('--out');
if (!file) stop('Usage: node scripts/extract-public-list.mjs page.txt [--kind speaker|partner|exhibitor|startup] [--out file.csv] [--dry-run]');
const pageText = fs.readFileSync(file, 'utf8');
if (!pageText.trim()) stop(`${file} is empty.`);

const Row = z.object({
  first: z.string().describe('First name as written, or "" for a company-only entry'),
  last: z.string().describe('Last name as written, or ""'),
  company: z.string().describe('Company or organisation as written, or ""'),
  title: z.string().describe('Job title as written, or ""'),
  linkedin: z.string().describe('A linkedin.com/in/ URL only if it appears in the text, else ""'),
  city: z.string().describe('City only if the text states it, else ""'),
  kind: z.enum(['speaker', 'partner', 'exhibitor', 'startup', 'investor', 'attendee']),
});
const Extraction = z.object({ rows: z.array(Row) });

const system = [
  'You turn the text of a public event web page into a list of the people and organisations it names as taking part.',
  'Copy facts exactly as the text gives them. Never guess, complete or look up a name, company, title, city or URL.',
  'A LinkedIn URL is included only if a linkedin.com/in/ URL for that person appears in the text.',
  `Use kind "${kind}" unless the text clearly says otherwise for an entry. Company-only entries (sponsors, partners) have empty first and last names.`,
  'Leave out navigation, cookie banners, ticket offers and anything that is not a participant.',
].join(' ');

const request = {
  model: 'claude-opus-5-5',
  max_tokens: 16000,
  betas: ['server-side-fallback-2026-07-01'],   // on a policy decline, the API re-runs the request on a fallback model
  fallbacks: 'default',
  output_config: { effort: 'medium', format: zodOutputFormat(Extraction) },
  system,
  messages: [{ role: 'user', content: `Event page text (${kind} list):\n\n${pageText}` }],
};
if (args.includes('--dry-run')) {
  console.error(`Dry run: would send ${pageText.length.toLocaleString('en-US')} characters from ${file} to ${request.model} and write ${out || 'stdout'}.`);
  process.exit(0);
}

const client = new Anthropic();
let response;
try {
  response = await client.beta.messages.create(request);
} catch (e) {
  if (e instanceof Anthropic.AuthenticationError) stop('No valid Anthropic credentials: set ANTHROPIC_API_KEY in .env.local or run `ant auth login`.');
  if (e instanceof Anthropic.RateLimitError) stop('Rate limited by the Anthropic API; try again in a minute.');
  if (e instanceof Anthropic.APIError) stop(`Anthropic API error ${e.status}: ${e.message}`);
  throw e;
}
if (response.stop_reason === 'refusal') stop('The model declined this text. Check that it is the text of a public event page.');
if (response.stop_reason === 'max_tokens') console.error('Warning: the output hit max_tokens; the list may be cut short. Split the page text into two files.');
const textBlock = response.content.find((b) => b.type === 'text');
let parsed;
try { parsed = Extraction.parse(JSON.parse(textBlock?.text ?? '')); } catch { stop('The answer was not the expected JSON; nothing written.'); }

const cell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const keepUrl = (u) => (/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\//i.test(u.trim()) && pageText.includes(u.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').split('?')[0].slice(0, 40)) ? u.trim() : '');
const lines = ['First Name,Last Name,LinkedIn URL,Company,Title,City,Type', ...parsed.rows.map((r) => [r.first, r.last, keepUrl(r.linkedin), r.company, r.title, r.city, r.kind].map((v) => cell(String(v || '').trim())).join(','))];
const csv = lines.join('\n') + '\n';
if (out) fs.writeFileSync(out, csv); else process.stdout.write(csv);
const people = parsed.rows.filter((r) => r.first || r.last).length;
console.error(`${parsed.rows.length} rows (${people} people, ${parsed.rows.length - people} company-only), ${parsed.rows.filter((r) => keepUrl(r.linkedin)).length} with a LinkedIn URL found in the text.${out ? ` Wrote ${out}.` : ''} Check it before importing.`);
