# Lead Engine

A research agent for one-off, high-value leads, built for Abstract (abstract.inc).

Add a LinkedIn URL and a few notes, or import contacts from a CSV file, a Google Sheet or
HubSpot. The agent reads the person's LinkedIn profile and
posts, their company, the web, Hugging Face and X, and writes a sourced brief, a picture
of the company and three or four outreach angles, each with an email and a LinkedIn
message. You review, edit and send. Every claim in a draft links back to the page it
came from.

Every Claude call runs on **Claude Haiku 5.5 at low effort**. A full research run takes
about 1.5 minutes and costs a few cents.

## How a run works

1. **Identify**: LinkedIn profile (Unipile, Apify as fallback), company and domain. A lead
   without a URL is looked up first: up to 2 Exa searches, and a profile is only taken when
   the name matches and so does the company or the email's domain.
2. **Gather, in parallel**: LinkedIn posts and company page, Apollo company data and job
   postings, Exa web and people search, Hugging Face accounts and models, a Hunter email,
   and X posts through Grok (only once the handle is verified). A re-run with a reason adds
   one web search for it.
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

### Analytics

PostHog tracks page views and named actions (lead created, drafts copied, marked as sent,
stage changes, steering, settings saved, imports, re-runs with a reason, email lookups and
edits, leads marked unqualified, restored or deleted) through the app's own `/ingest` path. Only ids,
counts and timings are sent; never names, emails, notes or draft text. Session recording
and autocapture are off. Set `NEXT_PUBLIC_POSTHOG_KEY` to turn it on (it is fixed at build time).

### Environment variables

See `.env.example` for every variable with a description. Required: `DATABASE_URL`,
`ANTHROPIC_API_KEY`, `EXA_API_KEY`, and a LinkedIn source (`UNIPILE_API_KEY` +
`UNIPILE_DSN`, or `APIFY_TOKEN`). Optional: `APOLLO_API_KEY`, `HUNTER_API_KEY`,
`OPENROUTER_API_KEY`, `ABSTRACT_API_KEY`, `HF_TOKEN`, `HUBSPOT_ACCESS_TOKEN`.
On any public URL also set `APP_PASSWORD` and `SESSION_SECRET` (`openssl rand -hex 32`).

The Settings page shows which integrations are on and why.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel (framework: Next.js).
2. Add every variable from `.env.local` in Project Settings → Environment Variables,
   plus `APP_PASSWORD` and `SESSION_SECRET`. Mark the keys as sensitive. Without
   `APP_PASSWORD` the deployment answers 503 to everything, unless `ALLOW_OPEN_ACCESS=1`
   is set to run it open on purpose (runs stay capped; see Run limits below).
   With Vercel's standard deployment protection the production domains are public, and
   per-deployment URLs and previews need a Vercel login.
   Apply new migrations (`npm run migrate`) before deploying the code that needs them.
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

### Run limits

Research and steer runs (the paid part) are capped across all leads: 20 in any rolling
hour and 25 in any rolling 24 hours by default (`RUN_LIMIT_PER_HOUR`, `RUN_LIMIT_PER_DAY`).
A research run costs about $0.15 and reads LinkedIn 4 times, so the daily default keeps
LinkedIn near 100 reads a day and spend near $4. Each slot is taken in one transaction
(`le_run_starts`), so a burst of requests cannot get past the caps, and deleting leads
does not give runs back. Over a cap, the API answers 429 and a new lead is saved without a run.
Set either limit to 0 to pause all runs. Runs started from `scripts/test-research.ts --full`
or `--steer` count toward the same caps.

Two more budgets work the same way (`le_quota_uses`):

- **Imports**: 2,000 new leads in any rolling 24 hours (`IMPORT_LIMIT_PER_DAY`). An import that
  would pass it adds nothing and says how many more fit.
- **Hunter credits**: 10 in any rolling 24 hours (`HUNTER_CREDITS_PER_DAY`), shared by Find email
  and research's email step. Each lookup reserves its worst case (1.5 credits: 1 when the
  Email Finder finds an address, otherwise Domain Search 1 plus the verifier 0.5) and keeps
  only what Hunter charged. When the budget is used up, Find email answers 429 and research
  skips the email step. The free plan has 50 credits a month.

On an open deploy (`ALLOW_OPEN_ACCESS=1`), HubSpot import is refused until `APP_PASSWORD` and
`SESSION_SECRET` are set: otherwise anyone with the URL could list the CRM's contacts.

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
- `docs/BUILD_SPEC.md` is the build contract the modules were written against.
