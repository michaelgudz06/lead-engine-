# Lead Engine

A research agent for one-off, high-value leads, built for Abstract (abstract.inc).

Add a LinkedIn URL and a few notes, or import contacts from a CSV file, a Google Sheet or
HubSpot. The agent reads the person's LinkedIn profile and
posts, their company, the web, Hugging Face and X, and writes a sourced brief, a picture
of the company and three or four outreach angles, each with an email and a LinkedIn
message. It also looks for people you know who could introduce you. You review, edit and
send. Every claim in a draft links back to the page it came from.

Every Claude call runs on **Claude Haiku 5.5 at low effort**. A full research run takes
about 1.5 minutes and costs a few cents.

## How a run works

1. **Identify**: LinkedIn profile (Unipile, Apify as fallback), company and domain. A lead
   without a URL is looked up first: up to 2 Exa searches, and a profile is only taken when
   the name matches and so does the company or the email's domain.
2. **Gather, in parallel**: LinkedIn posts and company page, Apollo company data and job
   postings, Exa web and people search, Hugging Face accounts and models, a Hunter email,
   and X posts through Grok (only once the handle is verified). A re-run with a reason adds
   one web search for it. Warm paths (below) start once gather ends and run alongside the
   next steps.
3. **Extract**: Haiku turns each source into small sourced facts and applies your criteria
   (for example, "no personal life").
4. **Fill gaps**: a short Haiku tool loop searches for what is still missing: robots and
   models used, how they run inference, hiring and who decides.
5. **Write and check**: Haiku writes the brief, company picture, angles and drafts, then a
   second pass checks every draft sentence against its sources.

Progress shows live on the lead page. You can steer a lead in plain English ("make the
first angle shorter", "dig into their compute setup").

## Working with leads

- **Import** (`/leads/import`, the Import button on Leads): a CSV file (read in the browser,
  up to 10 MB and 5,000 rows), a Google Sheet link (shared as "Anyone with the link, Viewer")
  or HubSpot contacts. Match the columns, tick the rows, import. A row needs a LinkedIn URL,
  or a name plus a company or an email. Duplicates are matched by LinkedIn profile, HubSpot
  id, email, or for rows with none of those, the name and company as first imported. A row
  that matches an unqualified lead is a duplicate too ("... (marked unqualified)"), so an
  import never brings it back.
  Importing never starts research: an imported lead reads "Not researched yet".
- **Taking leads off the list**: tick rows on Leads (or Select all, or Shift-click a range),
  then **Mark unqualified** (with an optional reason: Not a fit, Wrong person, No need right
  now, Competitor or partner, Bad or duplicate data) or **Delete**. Marked leads leave Leads
  and Pipeline at once, with Undo, and wait in the **Unqualified** view (`/?view=unqualified`)
  with their reason and date, where Restore puts them back on the stage they had. They keep
  their research, and imports keep skipping them. Delete is for good, and a later import can
  add the person again. On a lead's page, **Remove** offers both; an unqualified lead shows
  its reason (editable) and a Restore button. Pipeline hides unqualified leads and links to
  them.
- **Leads without LinkedIn** show "No LinkedIn yet". Add the URL on the lead page, or let
  research look for it. A wrong profile can be changed under Details, then re-run.
- **Re-run research** on a researched lead asks why first (up to 1,200 characters, with quick
  picks). The agent looks into the reason first, and the brief and drafts lean on it. It
  shows in the activity as "Re-run: ...". An empty reason is a plain re-run.
- **Email**: each address shows its kind: found by Hunter, verified from the company's
  pattern, a guess from the pattern (the mail server accepts every address, so it could not
  be checked; 50% sure), imported, or added by you. "Find email" runs one Hunter lookup
  without a research run; research and Find email never replace an address you added or
  imported. "Open in Gmail" fills the To line with it, and the line next to the button
  shows which address the draft will use.

## Warm paths

A lead's page shows who could introduce you to them, in a Warm paths panel right after the
Brief. "You" is the sender in Settings; teammates' networks are not used yet. Each row is one
way in, best first, and opens into the chain: you, the person in between, the lead. Each link
shows its evidence, such as "LinkedIn 1st degree", "Worked together at Northwind, 2019–2022" or
"Mutual follow on X", and a strength: Strong, Medium or Weak. A path is only as strong as its
weaker link. A direct tie gets its own box at the top. When no path is Medium or better, the
panel lists up to 5 people you know at the lead's company (matched by whole company words, and
shown with the company your export lists for them). On Leads and Pipeline, a lead with a Strong or
Medium path gets a "Connected" or "Warm path" chip, and Leads search matches the person in
between; a lead your upload marks Connected shows the same on its page, even before research.
A lead's X and Instagram handles can be added or fixed under Details.

People you both know (mutual connections) come only from X or your own LinkedIn account, below.
Until one of them runs for a lead, the panel never says that nobody links you: it says exactly
what it compared ("No direct link to Ada yet. Ada is not one of your 6,208 LinkedIn
connections, and you share no employer or school."), that mutual connections are not checked
here, with LinkedIn's own list of them one click away, and what to set up to check them here.

Your side comes from Settings > Your network:

- **Your LinkedIn connections**: Connections.csv from LinkedIn's data export. The file is read
  in your browser, and the email column never leaves it. A new upload replaces the old one. The
  file is a snapshot, so upload a new one about once a month.
- **Your LinkedIn profile URL**: your roles and schools, read once a month through the research
  account, to find where you and a lead worked or studied at the same time.
- **Your X handle**, with `TWITTERAPI_IO_KEY` set: twitterapi.io, a third-party X data service,
  reads who you follow and who follows you (at most once a day) and who the lead follows. No X
  login is used.
- **Your own LinkedIn account (optional)**: connected in Unipile and named in
  `UNIPILE_NETWORK_ACCOUNT_ID`. It reads the lead's degree and, for a 2nd-degree lead, up to 10
  connections you share. It reads LinkedIn as you, and LinkedIn may restrict accounts that use
  automation, so it is off until set and capped (see Run limits). Research never reads through it.
- **Instagram**: a link only. Nothing is ever read from Instagram. Your handle (optional) shows
  an Instagram row on leads; the lead's comes from their LinkedIn profile or is typed under Details.

Your profile URL and handles save with Save settings, and Read now and Refresh now use what is
saved.
Remove deletes your stored connections and every path found from them. Every lead also has
check-yourself links: LinkedIn's mutual connections, X's "Followers you know" and the lead's
Instagram profile. They open in your own logged-in browser, cost nothing, and the app reads
nothing from them.

When it runs:

- In every research run, but not in steer runs. It starts right after gather and runs alongside
  writing, capped at 60 seconds, so a normal run takes no longer.
- On Find warm paths or Check again in the panel. These read LinkedIn and X again even when
  recent results are kept, within the daily budgets.
- When you open a lead after your side changed (an upload, a refresh, a new handle or profile
  URL, a key added or removed on the server), the panel is redone from stored data first, with
  no outside call, so its footer always follows what is set up now.

**Intro requests.** Draft intro request writes one short message to the person in the middle,
with a paragraph they can forward as it is (Haiku 5.5 at low effort, about $0.0004). Nothing is
sent from the app: copy it, send it yourself, then Mark as asked. Copy and Mark as asked are
logged to the lead's Activity. Redraft asks before it replaces a message you edited (in another
browser, it always asks).

**What is kept.** Migration 007 adds `le_network_contacts` (your connections, and your X follows
and followers), `le_network_sources` (your roles and schools, and the state of each source),
`le_warm_paths` (per lead: up to 10 paths, 5 people at the company, the last live checks and the
intro drafts) and `le_leads.warm_path` (the list chip). Never read or stored: the lead's own
follower and following lists (only the paths found), email addresses, cookies or tokens,
anything from Instagram, and the research account's own network. Contact names never go to
server logs, analytics, error messages or URLs: a path's id in a URL is a short hash.

**On an open deploy.** Warm paths work without the team password. No route returns your contact
lists: `GET /api/network` gives counts and states only, and a lead's page shows at most 10 paths
and 5 people at the company. But while Lead Engine is open to anyone with its link, they can see
the people shown on lead pages. Setting `APP_PASSWORD` (with `SESSION_SECRET`) closes it. Settings
says so while the app is open.

**Cost.** Your connections, your profile and the links cost nothing. X costs about $0.01 to $0.04
a lead and $0.15 at most, plus about $0.03 to refresh your own lists, at most once a day. These
are estimates from twitterapi.io's credit table ($1 is 100,000 credits): its API does not say
what a call cost. Your own LinkedIn account adds no fee, since Unipile's paid plan covers up to
10 linked accounts.

### Setting up warm paths

1. Run `npm run migrate` (migration 007) before deploying this code.
2. In Settings > Your network, add your LinkedIn profile URL and save. Read now reads it at once;
   otherwise the next check does.
3. Export your LinkedIn connections on a computer: Me > Settings & Privacy > Data privacy >
   Download your data > Connections > Request archive. LinkedIn emails a link, usually within
   48 hours, that works for 72 hours. Unzip it and upload Connections.csv under Your connections.
   Upload a new export about once a month.
4. For X, create a twitterapi.io account and an API key, and top up $5 to $10 (paid credits do
   not expire). Set `TWITTERAPI_IO_KEY` in Vercel and `.env.local`, and redeploy. Then add your
   X handle in Settings and save.
5. Optional: add your Instagram handle, to show the Instagram row on leads.
6. On a lead you know, click "Mutual connections on LinkedIn" and "Followers you know on X"
   once. LinkedIn and X do not document either link, so check that both still work.
7. Optional, your own LinkedIn account. First set `UNIPILE_ACCOUNT_ID` to the research account's
   id and redeploy: once `UNIPILE_NETWORK_ACCOUNT_ID` is set, research reads LinkedIn through
   Unipile only with that pin, and uses the Apify fallback without it.
8. Then make sure the Unipile workspace is on the paid plan, not the trial, and connect your own
   LinkedIn in the Unipile dashboard. Set `UNIPILE_NETWORK_ACCOUNT_ID` to its id and redeploy.
   Settings > Your network shows its state.
9. Press Check again on a lead you know is 2nd degree, and compare the people shown with
   LinkedIn's own list. The shared-connections search is not yet proven on a real 2nd-degree
   lead. When its results fail a safety check, the panel says so and keeps the LinkedIn link.
10. Optional: change the daily budgets (Run limits below).

## Stack

Next.js 16 (App Router), React 19, Tailwind 4, Neon Postgres over HTTPS
(`@neondatabase/serverless`), the Anthropic TypeScript SDK, deployed on Vercel.

| Part | Choice |
| --- | --- |
| LinkedIn | Unipile on a separate LinkedIn account; Apify (HarvestAPI actors) as fallback |
| Company data | Apollo (company enrich and job postings work on the free plan) |
| Web and people | Exa |
| X | Grok through OpenRouter with X search, pinned to the person's handle |
| Email | Hunter: the Email Finder, then the company's email pattern (Domain Search and the verifier) |
| Models | Hugging Face Hub API; Abstract's checkpoint inspect when a key is set |
| CRM | HubSpot push and contact import (built, not yet tested against a live account) |
| Warm paths | Your Connections.csv and LinkedIn profile, X follows through twitterapi.io, and optionally your own LinkedIn on Unipile |

## Run it locally

```bash
npm install
cp .env.example .env.local   # then fill in the keys
npm run migrate              # creates the le_* tables in Neon
npm run dev                  # http://localhost:3000
```

The access gate is off locally unless `APP_PASSWORD` is set.

### Usage tab

`/usage`, in the main nav. It shows what every API key has used and spent: totals, a card per
provider with its live balance (Hunter credits, OpenRouter limit, Apify monthly usage, Apollo
credits, Unipile status), daily spend over 30 days, the duration and cost of each research run,
the median and 95th-percentile time and the cost of each kind of request, cost per lead, and
every call (sortable, with a CSV export). Balances are free reads, checked at most once a
minute (or every 30 seconds with Refresh balances). It follows the same access rules as every
page, so on an open deploy anyone with the URL can see it.

For warm paths, the "twitterapi.io (X follows)" card shows today's X budget ("$0.18 of $1.00 X
budget used today") and this month's estimated spend; it makes no balance call, since
twitterapi.io does not say whether that call is charged. Once your own LinkedIn account is set
up, the Unipile card shows the research account, your account and today's warm-path checks as
separate rows. twitterapi.io spend is drawn inside "Other" on the daily chart, and the legend
names it.

### Analytics

PostHog tracks page views and named actions (lead created, drafts copied, marked as sent,
stage changes, steering, settings saved, imports, re-runs with a reason, email lookups and
edits, leads marked unqualified, restored or deleted) through the app's own `/ingest` path. Only ids,
counts and timings are sent; never names, emails, handles, notes or draft text. Session recording
and autocapture are off. Set `NEXT_PUBLIC_POSTHOG_KEY` to turn it on (it is fixed at build time).

Warm paths add eight events, with ids, counts and fixed values only: `warm_paths_checked`,
`warm_path_opened`, `warm_path_link_opened`, `warm_path_intro_drafted`, `warm_path_intro_copied`,
`warm_path_marked_asked`, `network_connections_uploaded` and `network_x_synced`. The
settings-saved event can now name the three new fields, never their values.

### Environment variables

See `.env.example` for every variable with a description. Required: `DATABASE_URL`,
`ANTHROPIC_API_KEY`, `EXA_API_KEY`, and a LinkedIn source (`UNIPILE_API_KEY` +
`UNIPILE_DSN`, or `APIFY_TOKEN`). Optional: `APOLLO_API_KEY`, `HUNTER_API_KEY`,
`OPENROUTER_API_KEY`, `ABSTRACT_API_KEY`, `HF_TOKEN`, `HUBSPOT_ACCESS_TOKEN`, and for warm paths
`TWITTERAPI_IO_KEY` and `UNIPILE_NETWORK_ACCOUNT_ID` (each off until set; their budgets are under
Run limits). On any public URL also set `APP_PASSWORD` and `SESSION_SECRET`
(`openssl rand -hex 32`).

Pin `UNIPILE_ACCOUNT_ID` to the research account. Without the pin, research uses the one LinkedIn
account in the Unipile workspace. With two or more, or once `UNIPILE_NETWORK_ACCOUNT_ID` is set,
it refuses to guess and uses the Apify fallback instead.

The Settings page shows which integrations are on and why.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel (framework: Next.js).
2. Add every variable from `.env.local` in Project Settings → Environment Variables,
   plus `APP_PASSWORD` and `SESSION_SECRET`. Mark the keys as sensitive. Without
   `APP_PASSWORD` the deployment answers 503 to everything, unless `ALLOW_OPEN_ACCESS=1`
   is set to run it open on purpose (runs stay capped; see Run limits below).
   With Vercel's standard deployment protection the production domains are public, and
   per-deployment URLs and previews need a Vercel login.
   Apply new migrations (`npm run migrate`) before deploying the code that needs them. Warm
   paths need migration 007: it only adds tables and a column and widens a check, so the code
   already deployed keeps working on it.
3. Keep Fluid compute on (the default). Routes that start research set
   `maxDuration = 300`, and a run is planned to finish within 280 seconds.
   `vercel.json` pins functions to `cle1` (Cleveland), next to the Neon database in
   `us-east-2`; change it if your database lives elsewhere.
4. Deploy, open the URL, log in with the team password, and add a lead.

### Rolling back

Code from before the Unqualified view has no Unqualified stage. While any lead is unqualified,
its Leads and Pipeline pages fail to load for everyone. So before rolling back to it (a Vercel
Instant Rollback, or any older build on this database), restore every unqualified lead:

- In the app: Leads, then Unqualified, Select all, Restore. Repeat until the Unqualified count
  is 0 (the view shows 500 at a time).
- From a script: GET `/api/leads?view=unqualified`, then POST `/api/leads/bulk` with
  `{"action":"restore","ids":[...]}` (at most 500 ids a call), until the view is empty.

Then roll back. Migration 006 can stay applied. Restoring clears the reasons, so mark those
leads again after you roll forward.

Code from before warm paths works on a database with migration 007, so 007 can stay applied too.
That older code does not drop a lead's warm paths when the lead's LinkedIn profile changes. After
you roll forward, re-run research on any lead whose profile was changed meanwhile.

### Run limits

Research and steer runs (the paid part) are capped across all leads: 20 in any rolling
hour and 25 in any rolling 24 hours by default (`RUN_LIMIT_PER_HOUR`, `RUN_LIMIT_PER_DAY`).
A research run costs about $0.15 and reads LinkedIn 4 times, so the daily default keeps
LinkedIn near 100 reads a day and spend near $4. Each slot is taken in one transaction
(`le_run_starts`), so a burst of requests cannot get past the caps, and deleting leads
does not give runs back. Over a cap, the API answers 429 and a new lead is saved without a run.
Set either limit to 0 to pause all runs. Runs started from `scripts/test-research.ts --full`
or `--steer` count toward the same caps.

More budgets work the same way (`le_quota_uses`):

- **Imports**: 2,000 new leads in any rolling 24 hours (`IMPORT_LIMIT_PER_DAY`). An import that
  would pass it adds nothing and says how many more fit.
- **Hunter credits**: 10 in any rolling 24 hours (`HUNTER_CREDITS_PER_DAY`), shared by Find email
  and research's email step. Each lookup reserves its worst case (1.5 credits: 1 when the
  Email Finder finds an address, otherwise Domain Search 1 plus the verifier 0.5) and keeps
  only what Hunter charged. When the budget is used up, Find email answers 429 and research
  skips the email step. The free plan has 50 credits a month.
- **Warm-path checks on your own LinkedIn account**: 10 in any rolling 24 hours
  (`WARM_PATH_LINKEDIN_CHECKS_PER_DAY`), at least 2 minutes apart, each at most 3 LinkedIn
  requests. A lead's result is kept 30 days unless you press Check again. A check that sent
  nothing to LinkedIn gives its unit back. When LinkedIn answers 429, checks on your account
  pause for 24 hours; after a 401 or a server error, for an hour.
- **X credits**: $1 of twitterapi.io credits in any rolling 24 hours (`WARM_PATH_X_USD_PER_DAY`,
  in dollars, cents allowed such as 0.5). A lead's check reserves 15,000 credits ($0.15) and keeps only what its calls
  cost. Refreshing your own lists comes out of the same budget. A lead's result is kept 7 days
  unless you press Check again.
- **Intro drafts**: 100 in any rolling 24 hours, fixed, so a loop on an open deploy cannot run
  up Claude calls. Over it, Draft intro request answers 429.
- **Warm-path checks from the lead page** (Find warm paths, Check again): 100 in any rolling 24
  hours across the app, fixed. The free part needs no outside call, so without a cap a loop on an
  open deploy could test any list of LinkedIn profiles against your connections. A check that
  compared nothing does not count. Research runs and page views are not counted here.
- **LinkedIn profile reads outside research runs**: 10 in any rolling 24 hours, fixed, on the
  research account: Read now, and the reads a check from the panel makes (your own profile when
  it is a month old, or a lead researched before warm paths existed whose research stored no
  profile). Leads researched before warm paths existed first use the LinkedIn profile their
  research already read and stored, so they need no new read: after you upload your connections
  or save your profile link, their warm paths fill in on their own. Read now also waits 10
  minutes after a read and 2 minutes after a failure. Research runs are capped by the run
  limits instead.

Set either warm-path budget to 0 to pause that source. When one is used up, research skips that
source and the panel's footer says so. Check again still matches your connections and work
history, and answers 429 only when every live source you set up is over its budget.

On an open deploy (`ALLOW_OPEN_ACCESS=1`), HubSpot import is refused until `APP_PASSWORD` and
`SESSION_SECRET` are set: otherwise anyone with the URL could list the CRM's contacts. Warm
paths stay on, within the budgets above (see Warm paths for what an open deploy shows).

Vercel's Hobby plan is for non-commercial use. It is fine for a prototype; move the
project to a team on a paid plan for real company use.

## Test scripts

Each provider has a live test script (they spend small amounts of credit and cap their
own calls). Run them with:

```bash
NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-research.ts
```

`NODE_USE_ENV_PROXY=1` is only needed behind an HTTPS proxy. `scripts/test-research.ts --full <linkedinUrl>`
runs a complete research pass for one lead and keeps it.

`scripts/test-paths.ts` tests warm paths with every provider mocked, so it spends nothing;
`--unit` runs only the parts that need no database. Its database part and section 7 of
`scripts/test-api.ts` write `le_settings` and the `le_network_*` tables, so they run only against
a local test copy of the database (a `DATABASE_URL` host ending in `.fake-neon.test`) and stop with
one failed check anywhere else. Section 7 of `scripts/test-usage-tab.ts` writes temporary rows and
deletes them, as its other sections do.

## Known limits

- Sending is manual in this version: "Open in Gmail" opens a filled-in draft (with the
  recipient when the lead has an email), and "Mark as sent" sets the follow-up date. Sending
  from the app and reply watching come next.
- HubSpot push and import are built against HubSpot's API docs but untested until a token is
  added. A push only writes to a contact found by its record id when that contact has the
  lead's email or first and last name.
- The Google Sheet import reads a sheet's first 5,000 rows.
- Apollo's person match needs a paid plan; person data comes from LinkedIn and Hunter.
- Abstract's checkpoint inspect is off until `ABSTRACT_API_KEY` is set.
- Fill in Settings > Sender (name, email, booking link, signature). Until then drafts end
  with `[your booking link]` and `[your name]` placeholders.
- Warm paths use the sender's network only, and your connections are as of your last export.
  LinkedIn's mutual-connections link and X's "Followers you know" link use formats neither site
  documents, and the shared-connections search on your own account is not yet proven on a real
  2nd-degree lead (Setting up warm paths, steps 6 and 9).
- twitterapi.io is an unofficial X data service with no service guarantee. If it breaks, X
  checks fail and the footer says so; LinkedIn and your connections still work.
- `docs/BUILD_SPEC.md` is the build contract the modules were written against.
