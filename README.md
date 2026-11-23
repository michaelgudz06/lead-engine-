# Lead Engine

A research agent for one-off, high-value leads, built for Abstract (abstract.inc).

Add a LinkedIn URL and a few notes. The agent reads the person's LinkedIn profile and
posts, their company, the web, Hugging Face and X, and writes a sourced brief, a picture
of the company and three or four outreach angles, each with an email and a LinkedIn
message. You review, edit and send. Every claim in a draft links back to the page it
came from.

Every Claude call runs on **Claude Haiku 5.5 at low effort**. A full research run takes
about 1.5 minutes and costs a few cents.

## How a run works

1. **Identify**: LinkedIn profile (Unipile, Apify as fallback), company and domain.
2. **Gather, in parallel**: LinkedIn posts and company page, Apollo company data and job
   postings, Exa web and people search, Hugging Face accounts and models, a Hunter email,
   and X posts through Grok (only once the handle is verified).
3. **Extract**: Haiku turns each source into small sourced facts and applies your criteria
   (for example, "no personal life").
4. **Fill gaps**: a short Haiku tool loop searches for what is still missing: robots and
   models used, how they run inference, hiring and who decides.
5. **Write and check**: Haiku writes the brief, company picture, angles and drafts, then a
   second pass checks every draft sentence against its sources.

Progress shows live on the lead page. You can steer a lead in plain English ("make the
first angle shorter", "dig into their compute setup").

## Stack

Next.js 16 (App Router), React 19, Tailwind 4, Neon Postgres over HTTPS
(`@neondatabase/serverless`), the Anthropic TypeScript SDK, deployed on Vercel.

| Part | Choice |
| --- | --- |
| LinkedIn | Unipile on a separate LinkedIn account; Apify (HarvestAPI actors) as fallback |
| Company data | Apollo (company enrich and job postings work on the free plan) |
| Web and people | Exa |
| X | Grok through OpenRouter with X search, pinned to the person's handle |
| Email | Hunter (one lookup per lead) |
| Models | Hugging Face Hub API; Abstract's checkpoint inspect when a key is set |
| CRM | HubSpot (V1, built but not yet tested against a live account) |

## Run it locally

```bash
npm install
cp .env.example .env.local   # then fill in the keys
npm run migrate              # creates the le_* tables in Neon
npm run dev                  # http://localhost:3000
```

The access gate is off locally unless `APP_PASSWORD` is set.

### Usage panel (owner only)

```bash
npm run admin                # then open http://127.0.0.1:3001/admin
```

Shows what every API key has used and spent, per lead and in total, with live balances
(Hunter credits, OpenRouter limit, Apify monthly usage, Apollo credits, Unipile status).
It has no password because it only answers on your own machine: on Vercel, on a
production build or from any other computer, `/admin` is a plain 404.

### Analytics

PostHog tracks page views and named actions (lead created, drafts copied, marked as sent,
stage changes, steering, settings saved) through the app's own `/ingest` path. Only ids,
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

### Run limits

Research and steer runs (the paid part) are capped across all leads: 20 in any rolling
hour and 25 in any rolling 24 hours by default (`RUN_LIMIT_PER_HOUR`, `RUN_LIMIT_PER_DAY`).
A research run costs about $0.15 and reads LinkedIn 4 times, so the daily default keeps
LinkedIn near 100 reads a day and spend near $4. Each slot is taken in one transaction
(`le_run_starts`), so a burst of requests cannot get past the caps, and deleting leads
does not give runs back. Over a cap, the API answers 429 and a new lead is saved without a run.
Set either limit to 0 to pause all runs. Runs started from `scripts/test-research.ts --full`
or `--steer` count toward the same caps.

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

- Sending is manual in this version: "Open in Gmail" opens a filled-in draft, and
  "Mark as sent" sets the follow-up date. Sending from the app and reply watching come next.
- HubSpot push is built against HubSpot's API docs but untested until a token is added.
- Apollo's person match needs a paid plan; person data comes from LinkedIn and Hunter.
- Abstract's checkpoint inspect is off until `ABSTRACT_API_KEY` is set.
- Fill in Settings > Sender (name, email, booking link, signature). Until then drafts end
  with `[your booking link]` and `[your name]` placeholders.
- `docs/BUILD_SPEC.md` is the build contract the modules were written against.
