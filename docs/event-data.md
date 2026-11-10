# Event data: finding events, knowing who attends, matching them to your networks

The Event map answers one question: **who at this event does someone in our community already know?** That takes
three steps. The first and last are simple; the middle one, knowing who attends, is where most ideas fall apart, so
this document is explicit about what works.

```
1. Discover events  ->  2. Get an attendee list  ->  3. Match it to everyone's networks  ->  invite
   (curated list)        (organiser, RSVPs,           (LinkedIn profile URL; company
                          public speaker pages)         name for company-level hits)
```

## 1. Discovering events ✅ implemented, needs upkeep

- **Your own events** (founder dinners, a summit): you already have them. Add them to `config.events`.
- **External events**: [`events/curated.js`](../events/curated.js) is a short, hand-checked list (Slush 2026,
  Techarena 2027 to start), each with the date it was checked and where. A platform team needs a few dozen relevant
  events a year; keeping that list by hand is cheaper and more reliable than a crawler, and it never shows a wrong
  date as fact.

```js
el.config = { ...yourConfig, events: window.FT_CURATED_EVENTS };
```

## 2. Getting an attendee list: the hard part

Public event websites **do not publish their attendee lists**. Slush, for example, lists speakers and partners on
its site; attendees see each other only inside the event app, behind a ticket. So "an API that checks the attendee
lists" cannot work for most events: there is no public list to check, and getting into the app's directory
automatically would break its terms and collect personal data people shared only with other ticket holders.

What does work, in order of how complete the list is:

| Source | How complete | LinkedIn URLs? | Status |
|---|---|---|---|
| **Your own registrations / RSVPs** (your dinners, your summit) | Complete | Yes, if the sign-up form asks for a LinkedIn profile (add the field) | ✅ CSV import: **Add the attendee list** or `el.addAttendees(eventId, csv)` |
| **The organiser's export**, when you are a partner, host or organiser | Large, and consented | Usually | ✅ Same CSV import. Getting the file depends on your agreement with the organiser |
| **Public speaker, partner and startup pages** | Small: people on stage, companies with booths | Sometimes (speaker pages often link profiles) | ✅ [`scripts/extract-public-list.mjs`](../scripts/extract-public-list.mjs): copy the page text, Claude turns it into rows |
| **Your community saying they'll go** ("I'm at Slush") | Your members only | Yes | ❌ Not built. Simple to add: a "going" toggle per member |
| Event-app attendee directories, LinkedIn event attendee lists | Large | Yes | ❌ Not built, on purpose: behind a login, terms forbid automated collection, and it is personal data people did not publish |

### The CSV the importer reads

Columns are matched by name, in any order, comma, semicolon or tab separated. Only these are read:

| Column (any of) | Used for |
|---|---|
| `First Name` + `Last Name`, or `Name` | The person (rows with only a company are kept for company-level matches) |
| `LinkedIn`, `LinkedIn URL`, `LinkedIn Profile`, `URL` | **The only way a person is matched** to someone in the networks |
| `Company`, `Organisation` | Company-level matches |
| `Title`, `Job Title`, `Position`, `Role` | Shown on the card |
| `City`, `Location` | Where they come from, on the map |
| `Type`, `Ticket Type`, `Category` | speaker, partner, exhibitor, startup, investor or attendee |

Any other column, email included, is ignored.

### Public pages with Claude

```sh
# 1. Open the event's public speakers page, select all, copy, paste into speakers.txt
# 2. Turn it into rows (needs ANTHROPIC_API_KEY in .env.local, or `ant auth login`)
npm install
node --env-file=.env.local scripts/extract-public-list.mjs speakers.txt --kind speaker --out speakers.csv
# 3. Check speakers.csv, then import it on the Event map
```

The script does not fetch or crawl anything: a person copies a page they can see. Claude is told to copy only
what the text says; a LinkedIn URL is kept only if it appears in the text. The result is a partial list: speakers and
partners, not the audience. It is labelled as such when imported.

## 3. Matching ✅ implemented and tested

- **A person** matches only by **LinkedIn profile URL**, normalised (`linkedin.com/in/x`). A name alone never merges
  two people: two "Anna Lindqvist"s are two people until a URL says otherwise.
- **A company** matches by its normalised name (`Kalkvik Cement AB` = `kalkvik cement`). That gives company-level
  hits: "someone from Kalkvik Cement is speaking; your community knows three people there."
- When your event is in the same city as the external event, people attending it rank higher in the invite list
  and the card says "Attending <event>". **Only attending** filters the list to them.
- Cities are placed on the map with a small built-in lookup; an unknown city is still matched, just not drawn.

Code: `matchEvent`, `parseAttendees`, `geocode` in `founder-tables-outreach.js`. Tests: `tests/events.test.mjs`.

## What is real and what still needs a data source

| Part | Status |
|---|---|
| Event discovery | ✅ Curated, checked list. Needs someone to keep it current |
| Attendee lists for **your own** events | ✅ Works today with your RSVP export (ask for a LinkedIn URL in the form) |
| Attendee lists for **external** events | ⚠️ Needs the organiser's export (a partnership question, not a code question). Without it: public speakers and partners only, via the Claude script |
| Matching and the map | ✅ Implemented and tested |
| The example page | Three invented networks and three fictional events (`examples/`), so you can try it without real data |
