# Lead Engine: build spec

Lead Engine is a small web app for Abstract (abstract.inc, an inference API for robot AI
models and open LLMs). A person on the GTM team adds one lead: a LinkedIn URL, plus an
optional name, company and notes. An agent researches the person and their company,
builds a sourced brief and a picture of the company, and writes several outreach
"angles", each with an email draft and a LinkedIn message. The person reviews, edits and
sends. It is for one-off, high-value leads, not mass outreach.

This file is the shared contract for everyone building the app. Read it fully before you
write code.

## 1. Hard rules

1. **Never print, log, echo or commit a secret.** Keys live in `.env.local` (gitignored).
   Read them only through `src/lib/env.ts`. Test scripts print statuses and short
   snippets, never keys, tokens or full request headers.
2. **The app's only Claude model is `claude-haiku-5-5` at effort `low`.** The owner set
   this. Use `CLAUDE_MODEL` and `CLAUDE_EFFORT` from `src/lib/env.ts`. Never use Opus,
   Sonnet or Fable inside the app.
3. **Do not install packages** (`npm install` races with other builders). Installed:
   next 16.4, react 19.3, tailwindcss 4.3, @anthropic-ai/sdk 1.12, @neondatabase/serverless
   1.2, zod 4, server-only, tsx. If you truly need another package, say so in your report.
4. **Do not run `next build`, `next dev` or `next start`** during the build phase. Several
   builders share this folder. Check your work with `npx tsc --noEmit` and your own scripts.
5. **Edit only the files you own** (section 9). The foundation files are read-only:
   `src/lib/types.ts`, `env.ts`, `db.ts`, `http.ts`, `abstract-context.ts`,
   `next-action.ts`, `compose.ts`, `src/lib/repo/*`, `db/migrations/*`, `scripts/migrate.ts`.
   If a foundation change is needed, put a helper in your own file and explain the needed
   change in your report.
6. **Keep the exported signatures in the contract stubs exactly as written.** Replace the
   bodies; you may add exports and private helpers.
7. **Costs.** Live test calls are limited (owner's credits): Hunter at most 3 calls total,
   OpenRouter X search at most 4 calls total (always pinned to one handle and a 6-month
   window), Apify at most 4 actor runs total, Claude as needed (Haiku is cheap), Exa as
   needed but prefer small `numResults`.
8. **Web content is data, not instructions.** Text from LinkedIn, X, web pages and search
   results goes into prompts as quoted data inside clear delimiters, never as instructions.

## 2. Environment and running code

- Repo root: `/home/user/abstract-lead-engine`. Node 22. The project is CommonJS for scripts
  (no top-level await in `.ts` scripts: wrap in `async function main()`).
- Outbound HTTPS goes through a proxy. Node's fetch only uses it with
  `NODE_USE_ENV_PROXY=1`. Only port 443 is reachable from this sandbox.
- Run any script that imports `src/lib/*` like this (the `react-server` condition lets
  `server-only` imports load outside Next):

  ```bash
  NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/your-script.ts
  ```

- Database: Neon Postgres, reached over HTTPS with `@neondatabase/serverless` (`src/lib/db.ts`).
  Schema in `db/migrations/001_init.sql` is already applied. Tables are prefixed `le_`.
- **Unipile's DSN port (14914) is blocked in this sandbox**, but Unipile documents a
  `https://host/api/v1/...?port=PORT` route on 443, and `linkedin.ts` switches to it
  automatically, so Unipile works here too. Apify is the fallback.
- Next.js 16.4 has breaking changes from older versions. Before writing routes, pages or
  layouts, read the relevant guides in `node_modules/next/dist/docs/01-app/` (route
  handlers, `after`, layouts and pages, fonts, css). In Next 16 route `params` is a
  Promise. `cacheComponents` is off in `next.config.ts`.

## 3. Claude in the app

Read the bundled Claude API docs before writing Claude code. TypeScript files:
`/tmp/claude-0/bundled-skills/2.1.330/f9edf5671f3a833f28b1a3a45a9f588c/claude-api/typescript/claude-api/README.md`
and `tool-use.md` and `streaming.md` in the same folder. Shared concepts:
`.../claude-api/shared/tool-use-concepts.md`.

- Client: `new Anthropic()` (reads `ANTHROPIC_API_KEY`). Model `claude-haiku-5-5`,
  `output_config: { effort: "low" }`. Do not send `temperature`/`top_p`/`top_k`
  (the API version in use rejects them). Do not send a thinking budget.
- Structured output: `client.messages.parse({ ..., output_config: { effort: "low", format: zodOutputFormat(schema) } })`
  from `@anthropic-ai/sdk/helpers/zod`; read `parsed_output` and guard null.
- Tools: prefer the beta Tool Runner `client.beta.messages.toolRunner({...})` with
  `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`, with a cap on iterations.
- Always check `stop_reason` (`refusal`, `max_tokens`). Haiku 5.5 has no server-side
  refusal fallback: treat a refusal as a step failure and move on.
- Track usage (`usage.input_tokens`, `output_tokens`) per lead with `addUsage(leadId, {...})`.
- Use typed SDK errors (`Anthropic.RateLimitError`, `Anthropic.APIError`), not string matching.

## 4. Architecture

```
UI (Next.js app router, client components)  ->  /api/* route handlers  ->  repo (Neon)
                                                      |
                                       after(() => runResearch(id))
                                                      v
            research/pipeline.ts: identify -> gather (providers, in parallel) -> extract (Haiku)
                                  -> gap-fill agent (Haiku + tools) -> write (Haiku) -> verify -> save
```

Every step writes progress to `le_leads.research_step` and to `le_events` so the UI can
show it live (the UI polls `GET /api/leads/[id]` every 2 seconds while research runs).

## 5. Provider contracts

The fixed signatures are in `src/lib/providers/*.ts` (read them). Implementation notes:

- **linkedin.ts**: Unipile first when `UNIPILE_API_KEY` and `UNIPILE_DSN` are set
  (account id from `UNIPILE_ACCOUNT_ID` or the first OK LinkedIn account from
  `GET {DSN}/api/v1/accounts`, cached in memory); on any Unipile failure fall back to Apify
  when `APIFY_TOKEN` is set. For Apify, pick an actor from the Apify Store
  (`GET https://api.apify.com/v2/store?search=...`) that reads public LinkedIn profiles
  and posts by URL **without cookies** and works on the free plan; call it with
  `run-sync-get-dataset-items`. Map every field defensively; unknown shapes become null.
  Set reasonable timeouts (Apify runs can take ~60-120 s).
- **apollo.ts**: header `x-api-key`. `organizations/enrich?domain=`, job postings by org id,
  `people/match` (403 on the free plan: return `planBlocked: true`, no error).
- **hunter.ts**: Email Finder; it accepts a LinkedIn handle
  (see hunter.io/api and its changelog), else name + domain. When it has no address and the
  company domain is known: Domain Search for the pattern, an address built from it, and the
  Email Verifier unless the domain accepts every address (then the address is a `guess`,
  confidence 50). At most 1.5 credits a lookup. Ledger operations: `email-finder`,
  `domain-search`, `email-verifier`, each with units `{ lookups: 1, credits }`.
- **exa.ts**: `POST https://api.exa.ai/search` and `/contents`, header `x-api-key`.
  Check current docs (docs.exa.ai) for the people category and filters.
- **xsearch.ts**: OpenRouter chat completions (`https://openrouter.ai/api/v1/chat/completions`)
  with model from `OPENROUTER_X_MODEL` (default `x-ai/grok-4.7`) and the
  `openrouter:web_search` server tool with `engine: "native"` and an `x_search` object
  (`allowed_x_handles`, `from_date`). Docs: https://openrouter.ai/docs/guides/features/server-tools/web-search.md
  Ask Grok for strict JSON in its reply. Pin `getXPosts` to the one handle.
- **huggingface.ts**: `https://huggingface.co/api/...` (quicksearch, models by author with
  `expand`/`full` to read base model tags, datasets by author). No key.
- **abstract.ts**: inspect endpoint as in the docs; no key -> `configured: false`.
- **hubspot.ts**: CRM v3 objects (companies, contacts, deals) + associations + a logged
  note or email; upsert by email/domain. Untestable without a token: make it obviously
  correct and defensive.
- Every `*Status()` returns `{ id, label, configured, detail }` with no network call.

## 6. Research pipeline (owned by the research agent)

`runResearch(leadId, { focus? })` (research already claimed by the caller). `focus` is a
re-run's reason: the agent looks into it first, gather adds one web search for it, and the
brief and drafts lean on it. A lead without a LinkedIn URL is looked up first (section 11).

1. **Identify.** Read the lead. Fetch the LinkedIn profile. Fill name, title, company,
   location, company LinkedIn URL. Find the company domain (LinkedIn company website,
   Apollo, or an Exa company search) and save it. Apollo `matchPerson` when not plan-blocked.
2. **Gather, in parallel** (each source is optional; skip cleanly when not configured or it
   fails, and log an event): LinkedIn posts; LinkedIn company page; Apollo org enrich and
   job postings; Exa searches (people category for the person; the person's name plus
   company for talks, podcasts, papers, interviews; company news from the last 12 months);
   Hugging Face accounts for the company and the person, their models and datasets, and an
   inspect check on any model whose base Abstract serves (only if the key is set); Hunter
   email (one call); X handle via `findXHandle` and, only if confidence >= 0.7, `getXPosts`.
   Save raw responses with `saveRaw` for debugging (no secrets).
3. **Extract.** Turn each source's raw data into atomic `NewFinding`s with Haiku (structured
   output), in parallel with a small concurrency limit. Each finding: kind, title, one or two
   factual sentences, url, date, confidence (right person?), relevance (useful for Abstract
   outreach?), and `passesCriteria` + `excludedReason` judged against the criteria rules from
   `getSettings()`. Deterministic facts (LinkedIn role, Apollo headcount, HF models) may be
   turned into findings in code without Claude. Drop low-confidence identity matches.
   Also add the user's own notes as a `notes` finding. Insert with `insertFindings`.
4. **Gap-fill agent.** One Haiku tool loop (max ~8 tool calls) with tools over the providers
   (web search, people search, page contents, Hugging Face models, X posts for the known
   handle, Apollo org) and a `record_finding` tool that saves new findings. Goal: answer what
   robots/arms and models they use, how they run inference today, recent announcements,
   hiring for ML infrastructure, and who decides on infrastructure spend. It must stop early
   when it has enough.
5. **Write.** With Haiku (structured output) from the passing findings plus
   `ABSTRACT_CONTEXT` and `ANGLE_LIBRARY`: `Brief`, `CompanyPicture`, 2 to 4 well-supported
   `Angle`s, never padded to a fixed count (each
   cites findingIds and has an email and a LinkedIn message under 300 characters) and an
   `Approach`. Drafts: plain, specific, short (under 120 words), no hype, no invented facts,
   the sender's name and Calendly link from settings when set (leave a clear
   `[your booking link]` placeholder otherwise). Every brief bullet cites real finding ids.
6. **Verify.** A second Haiku pass checks each draft sentence against the cited findings
   and the Abstract context; unsupported claims are rewritten once. Strip any finding id that
   does not exist.
7. **Save** brief, companyPicture, angles, approach; `finishResearch(id, 'done')`; event
   "Research done". On a fatal error: `finishResearch(id, 'error', message)` and an error event.
   A whole run should take about 1 to 3 minutes; put a timeout on every network call.

`steerLead(leadId, instruction)`: classify with Haiku into `rewrite` (regenerate angles and
drafts following the instruction, keep findings and brief) or `research` (run the gap-fill
agent focused on the instruction, then rewrite brief and angles). Log a `steer` event and
finish the run the same way.

## 7. HTTP API (owned by the api agent)

All JSON. Errors: `{ error: string }` with a 4xx/5xx status. Validate bodies with zod.

| Method and path | Body | Response |
| --- | --- | --- |
| GET /api/leads | | `{ leads: Lead[] }` |
| POST /api/leads | `{ linkedinUrl, name?, companyName?, notes? }` | 201 `{ lead }`; 409 `{ error, existingId }`; starts research with `claimResearch` + `after(() => runResearch(id))` |
| GET /api/leads/[id] | | `LeadDetail` `{ lead, findings, events }`; 404 |
| PATCH /api/leads/[id] | any of `stage, notes, owner, nextStepAt, email, name, title, companyName, angles, linkedinUrl` | `{ lead }` (log a `stage` event when the stage changes); `linkedinUrl` 409 `{ existingId }` when another lead has that profile; a typed `email` is saved as `manual` |
| DELETE /api/leads/[id] | | `{ ok: true }` |
| POST /api/leads/[id]/research | `{ focus? }` (up to 1,200 characters) | 202 `{ ok: true }`; 409 if already running; 429 over the run caps. A focus logs a `steer` event "Re-run: <focus>" |
| POST /api/leads/[id]/steer | `{ instruction }` | 202 `{ ok: true }`; 409 if running |
| POST /api/leads/[id]/sent | `{ angleId, channel: "email" \| "linkedin" }` | `{ lead }`: stage `contacted`, `lastContactedAt` now, `nextStepAt` now + `followUpDays`, `sent` event |
| POST /api/leads/[id]/events | `{ type: "copied" \| "note", message }` | `{ ok: true }` |
| POST /api/leads/[id]/hubspot | | `{ ok, contactId?, companyId?, dealId? }`; 400 when not configured |
| GET /api/settings, PUT /api/settings | `Partial<Settings>` | `{ settings }` |
| GET /api/status | | `{ providers: ProviderStatus[], model: { name, effort }, authEnabled: boolean }` |
| POST /api/login, POST /api/logout | `{ password }` / none | `{ ok: true }` or 401 (see 8b) |

Route handlers that start research must set `export const maxDuration = 300` and use
`after` from `next/server`.

## 8. UI (owned by the ui agent)

**Look.** Match abstract.inc: clean, white and black, calm, no gradients, no shadows beyond
a hairline, no decorative illustrations. Tokens (put them in `src/app/globals.css` with
Tailwind v4 `@theme`):

- ink `#22221f` (text, primary buttons), paper `#ffffff`, quiet `#767670` (secondary text),
  hairline `#e4e4df` (borders, dividers), wash `#f6f6f3` (hover and subtle fills),
  link `#234cd0` (links only), danger `#b42318`, success `#1f7a3f`.
- Fonts with `next/font/google`: Inter for UI text; Newsreader (serif) for the wordmark
  "Lead Engine" and page titles. Body 14-15px, comfortable line height.
- Buttons: primary = ink background, white text, 8px radius, 36px tall, medium weight;
  secondary = white with hairline border; ghost = text only. Clear hover and focus-visible
  states, disabled states with a tooltip that says why.
- Chips/badges: rounded-full, hairline border, 12px text. Cards: hairline border, 10px radius.
- Light mode only. Responsive down to phone width (single column).

**Pages** (all client components fetching the API; show skeletons while loading, and
friendly empty and error states):

1. **App shell**: top bar with the serif wordmark "Lead Engine", nav (Leads, Pipeline,
   Usage, Settings) and a primary "+ New lead" button.
2. **Leads `/`**: "Needs you first" list sorted with `sortNeedsYouFirst`, each row showing
   name, title at company, stage chip and next-action label (`nextAction`). Search box.
   On wide screens, a two-column layout like the mock: list on the left, the selected lead
   on the right is optional; a simple list that links to `/leads/[id]` is fine.
3. **New lead** (`/leads/new` page or a modal): LinkedIn URL (required, validated), name,
   company, notes (textarea: "How you know them, what was said, what you want"). Submit ->
   navigate to the lead page. Handle 409 by linking to the existing lead.
4. **Lead page `/leads/[id]`**: header (name, title at company, location, LinkedIn link,
   email if found, X handle if found); chips for stage (a select to change it), owner,
   follow-up date; actions: Re-run research, Push to HubSpot (disabled with reason when not
   configured), Delete (confirm). While research runs: a live progress panel with the
   current step and the latest events. Sections:
   - **Brief**: summary, bullets with small source links (finding ids -> finding url),
     pains, likely objections, questions for the first call.
   - **Company picture**: one-liner, headcount, growth, funding, team, hiring, robots and
     models, decision makers.
   - **Angles**: tabs, one per angle, recommended angle marked. Each tab: why this angle,
     email subject and body (editable textareas, saved with PATCH), LinkedIn message with a
     character count, buttons: Copy email, Open in Gmail (`gmailComposeUrl`), Copy LinkedIn
     message, Open LinkedIn profile, Mark as sent (POST /sent).
   - **Steer**: one input, "Tell the agent what to change or dig into", submit -> POST /steer.
   - **Findings**: all findings grouped by source, with title, text, date, link, and a toggle
     "Show filtered out" for findings that failed the criteria (show the reason).
   - **Activity**: the event timeline, newest first.
5. **Pipeline `/pipeline`**: columns by stage (`STAGES`), compact cards, a stage select on
   each card (PATCH).
6. **Settings `/settings`**: sender name, sender email, Calendly link, email signature,
   follow-up days, criteria rules (editable list), and an Integrations panel from
   `GET /api/status` (configured or not, and why). Show the model line:
   "Claude Haiku 5.5, low effort".

`src/lib/api-client.ts` (ui agent) holds typed fetch helpers for every endpoint in section 7.

## 8b. Access gate (api agent + ui agent)

The app has no user accounts. When deployed it must not be open to the internet: anyone with
the URL could read leads and spend API credits. Add one shared team password:

- `APP_PASSWORD` and `SESSION_SECRET` env vars (already in `src/lib/env.ts`). When
  `APP_PASSWORD` is unset on a local run, the gate is off. On Vercel the app refuses every
  request with 503 until `APP_PASSWORD` is set, so a deploy can never be open by accident.
- Cross-site writes to `/api/*` are refused (Sec-Fetch-Site / Origin check), research and
  steer runs are capped at 20 per hour and 25 per day (`RUN_LIMIT_PER_HOUR`,
  `RUN_LIMIT_PER_DAY`; each slot reserved atomically in `le_run_starts`, migration 003), and
  a run stuck in `running` for over 6 minutes is
  marked failed so it can be retried.
- `src/lib/auth.ts` (api agent): create and verify a signed session cookie with Web Crypto
  HMAC-SHA256 over an expiry timestamp using `SESSION_SECRET` (works in the proxy runtime);
  constant-time comparison of the password; cookie `le_session`, HttpOnly, Secure in
  production, SameSite=Lax, 30-day expiry.
- `src/proxy.ts` (api agent): Next 16 renamed middleware to proxy; read
  `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` first. Redirect
  unauthenticated page requests to `/login?next=...`; answer unauthenticated `/api/*`
  requests with 401 JSON; always allow `/login`, `/api/login`, `/_next/*`, favicon and
  public files.
- `POST /api/login { password }` sets the cookie (small fixed delay on failure);
  `POST /api/logout` clears it (api agent).
- `src/app/login/page.tsx` (ui agent): a calm, centred password form in the same style,
  then redirect to `next`. Add a "Log out" link in the app shell when the gate is on.

## 9. File ownership

| Owner | Files |
| --- | --- |
| linkedin agent | `src/lib/providers/linkedin.ts`, `scripts/test-linkedin.ts` |
| apollo-hunter agent | `src/lib/providers/apollo.ts`, `src/lib/providers/hunter.ts`, `scripts/test-apollo-hunter.ts` |
| exa-hub agent | `src/lib/providers/exa.ts`, `src/lib/providers/huggingface.ts`, `src/lib/providers/abstract.ts`, `scripts/test-exa-hub.ts` |
| x agent | `src/lib/providers/xsearch.ts`, `scripts/test-x.ts` |
| research agent | `src/lib/claude.ts`, `src/lib/research/**`, `scripts/test-research.ts` |
| api agent | `src/app/api/**`, `src/lib/providers/hubspot.ts`, `src/lib/auth.ts`, `src/proxy.ts`, `scripts/test-api.ts` |
| ui agent | `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/app/leads/**`, `src/app/pipeline/**`, `src/app/settings/**`, `src/app/login/**`, `src/components/**`, `src/lib/api-client.ts`, `public/**` |

## 10. Definition of done (every builder)

- Your files compile: `npx tsc --noEmit` shows no errors in files you own.
- Your code runs: a live test script for your module passes, within the cost limits.
- No secrets printed. No edits outside your files.
- Your final report lists: files written, what you tested and the output, what you could not
  test and why, anything another builder must know, and any foundation change you need.

## 11. Additions after V1: import, email, usage

**Data** (migrations 004 and 005, additive):

- `le_leads.linkedin_url` and `linkedin_slug` are nullable (imported contacts). New columns:
  `source` (`csv | sheet | hubspot`, null for single adds), `hubspot_contact_id` (unique when
  set), `email_status` (`found | verified | guess | imported | manual`), `import_key`
  (`lower(name)|lower(company)` as imported, for re-imports of rows with no other key), and an
  index on `lower(email)`. `Lead` gains `source`, `hubspotContactId` and `emailStatus`.
- `le_quota_uses (kind, units, lead_id, created_at)`: daily budgets with no row of their own,
  reserved in one transaction behind an advisory lock like `le_run_starts`. `import` counts
  new leads (`IMPORT_LIMIT_PER_DAY`, default 2,000). `email_lookup` counts Hunter
  half-credits (`HUNTER_CREDITS_PER_DAY`, default 10 credits): a lookup reserves 1.5 credits,
  then keeps only what Hunter charged. Find email and research's email step share it.
- Research and Find email never replace an `imported` or `manual` address.

**Routes:**

| Method and path | Body | Response |
| --- | --- | --- |
| POST /api/leads/import | `{ source, rows }` (at most 1,000 rows, 4 MB) | `{ created, createdIds, createdRows, duplicates, skipped }`; 429 `{ limit, remaining, wanted }` over the import budget (nothing is added). Never starts research; logs a `created` event `{ source }` |
| POST /api/import/sheet | `{ url }` (docs.google.com only) | `{ headers, rows, total, truncated, headerRow }`: the first 5,000 rows; the CSV is parsed only that far |
| GET /api/import/hubspot?limit= | | `{ headers, rows, total, more, linkedinProperties, warnings }` (up to 2,000); 403 `needs_password` on Vercel while `APP_PASSWORD` is unset; 400 `not_connected` without a token |
| POST /api/leads/[id]/email | | `{ email, emailStatus, emailConfidence, message, creditsUsed, lead }`; 409 for an address the team added; 429 `hunter_budget` when the day's Hunter credits are used up |
| GET /api/usage?window= | | `UsageResponse` (summary, leads, daily, operations, runs) |
| GET /api/usage/calls?window=&sort=&provider=&operation= | | `{ calls, total }` (a deleted lead's calls show "Deleted lead") |
| GET /api/usage/balances[?refresh=1] | | `{ balances, checkedAt, cached, refreshableAt }` (cached 60 s, refresh at most every 30 s) |
| GET /api/usage/export?window= | | CSV with a BOM; cells that start like a formula get a leading apostrophe |

**Leads without LinkedIn:** identify searches Exa (up to 2 searches) and takes a profile only
when the name matches and so does the company or the email's domain; otherwise the run stops
with a message asking for the URL.

**HubSpot push:** a contact found by its record id is only written to when it has the lead's
email or first and last name; otherwise the push falls back to the email or name match.

**Usage tab (`/usage`):** a run starts at its `le_run_starts` row and ends at the lead's first
`done` event, or else its last `error` event, within 6 minutes and before the next run. Its
cost is the lead's ledger rows from start to end plus 15 s. The proxy has rules 1 to 4 only;
the old local-only `/admin` panel is gone.

**Events:** `steer` for "Re-run: ...", `tool` for email lookups and "Found their LinkedIn by
search: ...", `created` with `{ source }` for imports.
