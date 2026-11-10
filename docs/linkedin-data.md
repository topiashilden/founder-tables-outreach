# Getting your LinkedIn connections into the tool

Each person in the community brings **their own** connections. There are two ways, and both end in the same
place: a `Connections.csv` without email addresses that the widget reads.

| | Export (CSV) | API token |
|---|---|---|
| Who can use it | Every LinkedIn member | Members in the **EEA or Switzerland** (it exists because of the EU Digital Markets Act) |
| Effort | A few clicks, then wait for an email | A one-time developer app, then one command |
| Freshness | A snapshot when you download it | Re-run the sync whenever you want |
| What you get | First and last name, profile URL, company, position, connected on (and emails, which are ignored) | The same fields |
| Implemented here | ✅ The widget's **Attach LinkedIn connections** button | ✅ `scripts/linkedin-sync.mjs` and `lib/linkedin-dma.mjs` (ported from warm-paths, tested against the documented response shape) |

Nothing here scrapes LinkedIn. Both routes are LinkedIn's own ways for a member to take out their own data.

## 1. The export (works for everyone)

1. On LinkedIn: **Me → Settings & Privacy → Data privacy → Get a copy of your data**.
2. Choose **Want something in particular?**, tick **Connections**, and request the archive.
3. LinkedIn emails you a link, usually within minutes for a single category (a full archive can take up to 24 hours).
4. Download the zip and find `Connections.csv` inside.
5. In the widget: **Attach LinkedIn connections**, pick the file. Say whose network it is and their role
   (platform team, Venture Partner, portfolio founder…).

The file is read in the browser and never uploaded. The Email Address column is never read: emails are missing for
many connections anyway, because each member decides whether connections may download it.

## 2. The API token (EEA and Switzerland)

LinkedIn's **Member Data Portability API** lets a member download their own data, including connections, with a
token they create themselves. Steps, from LinkedIn's documentation
([Member Data Portability (Member)](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member)):

1. Go to the [LinkedIn Developer Portal](https://www.linkedin.com/developers/) and **create an app**. For the
   company page, choose LinkedIn's default page **Member Data Portability (Member) Default Company**; that is the
   only way the product can be requested.
2. In the app's **Products** tab, request **Member Data Portability API (Member)**.
3. Under **Docs and tools → OAuth Token Tools**, open the **OAuth Token Generator**, choose the app, and create a
   token with the scope **`r_dma_portability_self_serve`**.
4. Put the token in `.env.local` (git-ignored) and never share it:

   ```sh
   LINKEDIN_DMA_TOKEN=paste-the-token-here
   ```

5. Run the sync (Node 20+, no other dependencies for this step):

   ```sh
   node --env-file=.env.local scripts/linkedin-sync.mjs --owner "Alex" --dry-run   # count only
   node --env-file=.env.local scripts/linkedin-sync.mjs --owner "Alex"             # writes private/Alex-Connections.csv
   ```

   It prints counts and field coverage, never a name or the token. `private/` is git-ignored.

Good to know, from running it in warm-paths:

- LinkedIn builds the snapshot after the token is created. Right after creating one, the API can answer "no data"
  for a while; try again later.
- Pages overlap (the same people come back on several pages). The sync keeps one row per person, by profile URL.
- The endpoint only accepts `Linkedin-Version: 202312`.
- Tokens expire. A `401` means: create a new token. A `403` means the app lacks the product or scope, or the member
  is outside the EEA/Switzerland.

## 3. Feeding a platform instead of a file

On a real platform, members would connect once and their network would refresh on its own. The pieces for that:

- `lib/linkedin-dma.mjs` runs on **your server** (LinkedIn's API cannot be called from a browser page, and the token
  must stay private). It calls the same Member Snapshot endpoint whichever token it is given.
- A platform does not use the self-serve token. It uses the **Member Data Portability API (3rd Party)** product with
  the scope **`r_dma_portability_3rd_party`**: each member signs in with LinkedIn (OAuth) and consents to share their
  data with the platform. LinkedIn has to grant that product to the platform's app, and it only works for members in
  the EEA or Switzerland. See [Member Data Portability APIs](https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability).
- Your server sends the rows (first, last, url, company, position; nothing else) to the page, and the page calls:

  ```js
  document.querySelector('founder-tables-outreach').addNetwork({
    name: 'Alex', role: 'Venture Partner', rows,   // or: csv: connectionsCsvText
  });
  ```

  `addNetwork` keeps only those five fields and drops anything else.

What still needs a real deployment: LinkedIn granting the 3rd Party product to the platform's app, the OAuth
sign-in for each member, and somewhere for your server to keep the tokens. Members outside the EEA and Switzerland
use the export. The fetching, the paging, the de-duplication and the import are implemented and tested.
