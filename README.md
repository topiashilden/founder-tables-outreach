# Founder tables outreach

**Your community's LinkedIn networks, in one search.** A drop-in tool for a community platform: the team, portfolio
founders and venture partners each attach their own LinkedIn connections, the networks merge into one, and you search
it for what you need ("plan an energy field founder dinner for the example industry summit"). It shows who fits,
who in the community knows them, who is attending an event, and lets you invite them from there.

The widget is one file with no dependencies and no build: `founder-tables-outreach.js`. It is a web component, so it
works in any stack. The scripts around it (LinkedIn token sync, public-page extraction) run on Node.

## What works today, and what needs a real data source

| | Status |
|---|---|
| Attach networks from a LinkedIn **export** (CSV) | ✅ In the widget. Read in the browser, emails never read |
| Attach networks with a LinkedIn **API token** | ✅ `scripts/linkedin-sync.mjs` (EEA and Switzerland, LinkedIn's Member Data Portability API). A platform needs LinkedIn to grant it the 3rd Party product. [docs/linkedin-data.md](docs/linkedin-data.md) |
| Merge networks, search by prompt, rank, draft invites, copy and open on LinkedIn, follow-ups | ✅ Rules in code, tested |
| Event discovery | ✅ A hand-checked list in `events/curated.js`. Needs upkeep |
| Who attends **your own** events | ✅ Import your RSVP export (ask for a LinkedIn URL on the form) |
| Who attends **external** events | ⚠️ Needs the organiser's export. Without it, public speakers and partners only, via `scripts/extract-public-list.mjs` (Claude). [docs/event-data.md](docs/event-data.md) |
| Matching attendees to the networks, the map | ✅ By LinkedIn URL for people, by name for companies. Tested |

Nothing scrapes LinkedIn or event sites, and nothing is sent for you.

## Attach it

```html
<script src="founder-tables-outreach.js"></script>
<founder-tables-outreach namespace="my-community"></founder-tables-outreach>
<script>
  document.querySelector('founder-tables-outreach').config = { /* see below */ };
</script>
```

`index.html` is a working host page with an invented example community (`examples/`): open it in a browser.
`examples/config.js` is a full example config. In React/Next, render the tag in a client component and set
`ref.current.config = …` in an effect.

## Config

| key | what |
|---|---|
| `id` | event id. Statuses (sent, replied…) are kept per id, so a new dinner starts clean |
| `title`, `intro` | heading and one line under it |
| `date`, `place`, `signature` | defaults; the prompt and the "Adjust the details" panel override them |
| `topics[]` | what a table can be about: `{ key, label, topic, why, keywords[], match: { title, org, req }, founders: [{ name, group }] }` |
| `topics[].match` | regexes (RegExp or string) on job title and company. `req`: `title`, `org`, `any` or `both` |
| `topics[].founders` | who is at the table. Used in the invite ("…including A, B and C") and to split people into tables of `tableSize` (default 6) |
| `events[]` | optional: `{ id, name, city, start, end, source, attendees: [...] }` (`lat`/`lon` optional: known cities are placed automatically). `window.FT_CURATED_EVENTS` from `events/curated.js` is a ready list. Adds the **Event map** tab (see below) |
| `map` | map geometry for the Event map; defaults to `window.FT_EUROPE` from `europe-map.js` |
| `simple` | `true` for the step-by-step layout: prompt, then attach networks, then "See who's coming" → event map → invite. Hides the rest |
| `examples[]`, `placeholder` | example prompts shown under the prompt box, and the prompt box's hint |
| `sample` | optional invented people for a "try it" button |
| `interpret(prompt, { topics, interpretPrompt })` | optional async hook to read the prompt your own way (e.g. with Claude). Return `{ eventWord, place, date, theme, topicKey, custom }` |
| `followUpDays` 7, `snoozeDays` 90, `colleagueDays` 30 | status rules |

With no config the tool still works: the prompt becomes a keyword search on titles and company names.

## Getting connections in

- **Export:** the **Attach LinkedIn connections** button reads LinkedIn's `Connections.csv`.
- **Token:** `node --env-file=.env.local scripts/linkedin-sync.mjs --owner "Alex"` writes the same CSV from the API.
- **From your server:** `el.addNetwork({ name, role, rows })` with rows `{ first, last, url, company, position }`.

Step by step, including how to get the token: [docs/linkedin-data.md](docs/linkedin-data.md).

## Event map

Give the tool an event's attendee list and it shows who is coming, where from, and **who in your community knows them**.

- Lists come from you: your RSVP export, the organiser's export, or a public speaker/partner page turned into rows by
  `scripts/extract-public-list.mjs`. Import with **Add the attendee list** on the Event map, or `el.addAttendees(eventId, csv)`.
  The tool never fetches or scrapes a list. Where lists can credibly come from: [docs/event-data.md](docs/event-data.md).
- People match your networks by **LinkedIn profile URL only** (a name never merges two people). Companies match by normalised name, to
  show where someone knows someone even if not the attendee.
- Each network can have a role (platform team, Venture Partner, portfolio founder…), shown as "known by Alex (Venture Partner)".
- When the dinner's city is the event's city, people attending rank higher (+1.5) and the card says "Attending <event>".
- `europe-map.js` is Natural Earth (public domain) as a hexagon-grid Europe; rebuild it with `scripts/make-map.cjs`.

## Events and storage

Events bubble from the element, without names or emails:

- `ft-import` `{ owner, mine, count }`
- `ft-sent` `{ person, kind: 'direct' | 'intro' | 'follow_up', topic, event, at }`
- `ft-status` `{ person, status, event }`

Data stays in the browser (`localStorage`, key `founder-tables-outreach:<namespace>`). To keep it per logged-in member
on your side instead, set an adapter: `el.store = { load(), save(data), clear() }` (sync or async). `data` holds
networks as compact rows (no email field exists), settings and statuses.

## Look

Black, white, square corners, Helvetica Neue. Everything is a CSS variable, so the host can restyle from outside:

```css
founder-tables-outreach { --ft-bg: #fff; --ft-fg: #000; --ft-accent: #000; --ft-on-accent: #fff; --ft-font: inherit; }
```

`theme="light"` switches to white. No logo or wordmark ships with the tool.

## Rules (from warm-paths; keep them)

- The Connections.csv is read in the browser. The Email column is never read or stored.
- People merge by LinkedIn profile URL only. A name alone never merges two people.
- Fit and ranking are plain rules (`fitFor`, `rank`), so the same data gives the same list. The prompt is read by rules too
  unless the host plugs in `interpret`. Nothing is invented.
- **Nothing is sent by the tool.** LinkedIn has no API for messaging your own connections, and automating it means
  scraping or breaking their terms. So "send" is a handoff: it copies the message, opens the person on LinkedIn, and the
  human presses send, then clicks "I sent it". The tracker records only what the person confirms.
- After 7 days without a reply someone shows under "Follow-up due". Replied, meeting and not-a-fit are never
  recommended again. When a colleague at the same company was contacted in the last 30 days, the others rank lower.
- Messages stay under 500 characters and never say how people were found.

## Test

```sh
npm test     # 29 tests: parser, merge, fit, rank, statuses, prompt, drafts, storage, LinkedIn API sync, attendee lists, matching
```

The LinkedIn sync is tested against invented pages in LinkedIn's documented response shape (ported from warm-paths); no
request leaves the machine. The Claude extraction script has a `--dry-run`; it needs an API key to run for real.

For the browser flow, open `index.html` and type `plan an energy field founder dinner for the example industry summit`.
The example data is regenerated with `node examples/make-data.mjs`.
