# LeadIntel AI — app

Express implementation of `LeadIntel App.dc.html` from the Claude Design project
[LeadIntel Phase 1 review](https://claude.ai/design/p/3f1d6f17-358f-45e7-8946-947652d98387).

```
npm install
npm start        # http://localhost:3000
npm run dev      # same, with --watch
npm run schemas  # re-derive schemas/ after a converter run
npm run rebind   # bind design literals to expressions (--check to report only)
npm run drill    # back up var/, wipe it, restore, verify the entities match
npm test         # node --test: ingest layer, sync runner, and the Phase 2 chrome
```

See **[PHASES.md](PHASES.md)** for the phased plan from here to a working product.

## Status

> **The numbers on screen are authored, not real, and not the design's.** The design file's
> data block exceeded the MCP read cap and never arrived, so the content under `data/` was
> written to be internally consistent with the facts the design hardcodes. Every module
> says so in its header. **Do not quote these figures to anyone.**
>
> Phase 1 was **closed on 2026-08-06 with this permanent**, after the design file went
> un-exported across six sessions. That was a decision to stop waiting, not a decision that
> the figures became real. Two things under `data/` are genuine design content and are
> marked as such; everything else is invented. See PHASES.md, Phase 1.

**This is a faithful UI shell, not a working product.** Be clear about what that means:

Working — the server and all 13 routes, the full app chrome (sidebar, top bar, global
filter bar) converted from the design, every screen's layout and all the charts and
figures the design hardcodes, sidebar navigation between screens, sidebar collapse,
hover states, the responsive grid rules, and routing into all 17 sub-views. Every
repeated region renders rows (authored — see the warning above). Row drill-through,
attribution model switching, the what-if simulator and URL-held segmented controls all
work. As of Phase 2's close: the ⌘K command palette, the notification panel, and filter
chips that genuinely narrow rows.

Not working — everything below, and none of it is close to working:

- **Filtering narrows tables only.** Totals, KPI headlines and charts are never
  recomputed for a subset; the app says so on screen whenever a filter is active. See
  `lib/filters.js`.
- **No backend of any kind.** No database, no API, no auth, no sessions, no integrations
  with Meta, Google, the CRM or the PMS. Express serves server-rendered HTML from static
  modules and nothing else.

In short: it looks and navigates like the product, and does none of the product's work.

| Screen | Route | Markup |
| --- | --- | --- |
| Executive Dashboard | `/` | complete |
| Marketing Dashboard | `/marketing` | complete |
| Campaign Analytics | `/campaigns` | complete (incl. campaign detail drill-down) |
| Creative Intelligence | `/creatives` | complete |
| Audience Analytics | `/audiences` | complete |
| Attribution | `/attribution` | complete |
| Website Analytics | `/website` | complete |
| AI Command Center | `/ai` | complete (8 sub-tabs) |
| Reports & Dashboards | `/reports` | complete (5 sub-tabs) |
| CRM Dashboard | `/crm` | complete |
| Lead Intelligence | `/leads` | complete (incl. lead profile) |
| Sales Pipeline | `/pipeline` | complete |
| Sales Analytics | `/sales` | **partial** — cut off by the read cap |

Two overlays (workspace switcher, creative detail drawer) are also converted.

### Sub-views

Several screens hold more than one view behind sibling `sc-if` flags — **32 sub-views in
9 groups**. All are routable via `?v=`, which is repeatable so a screen with several
groups can be addressed at once:

| Screen | Group | Sub-views |
| --- | --- | --- |
| `/ai` | `aiTabs` | `aiCommand`* · `aiChat` · `aiHealth` · `aiForecast` · `aiAnom` · `aiSim` · `aiGoals` · `aiRecsTab` |
| `/reports` | `repTabs` | `repBuilder` · `repScorecard` · `repPresent` · `repSchedule` · `repTemplates`* |
| `/campaigns` | — | `campList`* · `campDetail` |
| `/campaigns` | `campTabs` | `campTabCampaigns`* · `campTabAdsets` · `campTabAds` · `campTabKeywords` |
| `/campaigns` | `dTabs` | `dOverview`* · `dRevenue` · `dRes` · `dInsights` (campaign detail) |
| `/website` | `webTabs` | `webTabOverview`* · `webTabLanding` · `webTabFunnels` |
| `/leads` | — | `leadList`* · `leadProfile` |
| `/pipeline` | — | `pipeIsKanban`* · `pipeIsList` |
| `/sales` | `salesTabs` | `salesTeam`* · `salesCalls` |

`*` is the default when no `?v=` is given. Example:
`/campaigns?v=campDetail&v=dRevenue`. Tab strips render and are clickable; each tab links
to itself while holding every other group where it is.

**How groups are found.** `data/generated/_subviews.json` is generated. A group is a run
of `sc-if` blocks that are siblings in the markup — same parent, same nesting level. Two
refinements were needed and both are heuristics worth knowing about:

- Siblings can mix alternatives with modifiers: the campaign screen puts a breadcrumb flag
  (`showCrumb`) beside its `campList`/`campDetail` pair. Alternatives in this design are
  consistently named off a shared stem, so the converter keeps the members sharing the most
  common initial letter and drops the odd one out.
- `campTab*` and `webTab*` ship with **every** tab closed, so "exactly one default" would
  reject them. Groups with no default are accepted and the first member is opened, since a
  tab group that renders nothing is clearly not the intent.

Labels come from the section comment above each block where the designer wrote one
(`<!-- ANOMALIES & ROOT CAUSE -->` → "Anomalies & root cause"). Where there is no comment
the label is derived from the flag name, which is a guess about **wording only** — never
about which views exist. `dRes` becoming "Res" is one such guess; the design very likely
said "Reservations".

## Interactions

The design declares click targets as `onClick="{{ someFn }}"`, and those functions live
in its data script. The converter preserves them as `data-action` rather than inventing
behaviour. `public/assets/actions.js` wires only the ones whose name states the
destination and whose destination is a route this app already serves.

**Working** — sidebar navigation, sidebar collapse, all tab strips, and:
`backToCampaigns` · `backToLeads` · `closeCr` · `goPipe` · `goSales` · `goPresent` ·
`aiGoHealth` · `pipeKanban` · `pipeListGo` · `toggleAi` · `toggleWs` · `toggleEdit`.

**Overlays**, both server-rendered on a query flag so the toggles just flip it:

| URL | Shows |
| --- | --- |
| `?ws=1` | workspace switcher dropdown (in the top bar) |
| `?cr=1` | creative detail drawer (slide-over, any screen) |
| `?edit=1` | dashboard edit mode |

`?edit=1` is wired but currently shows nothing: its drag handle renders *inside* the
`heroKpis` loop, and that loop is empty until the content arrives.

**`openPalette` and `toggleNotif`** are wired as of Phase 2, in
`public/assets/app-ui.js` rather than `actions.js` — the design declares both triggers
but has no markup for what they open, so the surfaces under `views/app/` are ours and the
entry points are the design's. `stop` remains an event-propagation guard.

Row-click actions (`l.go`, `cr.go` and friends) are item-scoped and evaluate to whatever
the data supplies — the destination is the data's to name, not ours.

**Filter chips** are enhanced in place by `app-ui.js`: it reads the chips the converter
generated and attaches dropdowns, so the template stays free to be overwritten. Selecting
a value sets `?f_<dimension>=` and the server narrows matching row collections. What it
deliberately does *not* do is recompute totals — see `lib/filters.js` and the note the
shell renders whenever a filter is active.

| URL | Effect |
| --- | --- |
| `?f_property=Munnar Hillside` | rows carrying a `property` narrow to that value |
| `?f_channel=Meta` | rows carrying a `platform`/`channel` narrow |
| `?f_campaign=…` · `?f_room=…` | same, where rows carry the field |

The date range control still renders without filtering — the `ranges` list is authored
and there is one snapshot behind it.

## Layout

| Path | What it is |
| --- | --- |
| `server.js` | Routing and composition; one route per screen, all through the shared shell |
| `lib/repository/contract.js` | **The read API** — the five calls every request goes through |
| `lib/repository/static.js` | The implementation over `data/`; the only file that reaches into it |
| `lib/repository/index.js` | Driver selection (`LEADINTEL_REPO`) and the schema check that wraps any driver |
| `lib/schema.js` | Checks payloads against `schemas/` — development only |
| `lib/view-state.js` | Sub-view resolution from `?v=`; request state, not content |
| `lib/ingest/` | Stage 1–2 of the pipeline — connectors, raw store, normalisation, precedence |
| `lib/metrics/` | Stage 5 — the metric registry, formulas, dependency order |
| `lib/ingest/fixtures/` | **Synthetic** source payloads; there are no credentials for the real APIs |
| `var/raw/` | The raw store — append-only, written at sync time, safe to delete |
| `test/` | `npm test` |
| `schemas/<resource>.json` | **Generated** read contract — `npm run schemas` |
| `data/screens.js` | Screen registry — single source of truth for routes and sidebar |
| `data/generated/<view>.js` | **Generated** data shapes — do not hand-edit |
| `data/<view>.js` | Your content; shallow-merged over the generated shape, so it survives a re-run |
| `views/layout.ejs` | App shell — sidebar, nav, main column |
| `views/screens/<view>.ejs` | **Generated** screen markup — do not hand-edit |
| `tools/dc-to-ejs.js` | The converter (see below) |
| `public/assets/nocturne.css` | Nocturne design-system tokens, verbatim from `_ds/.../styles.css` |
| `public/assets/app.css` | Shell styles from the design's `<helmet>` block |
| `public/assets/hover.css` | **Generated** — one class per `style-hover` declaration |

## Data access

Nothing above `lib/repository/` knows where content is kept. Routes and views go through
five asynchronous calls — `screens`, `navigation`, `subviewGroups`, `read`, `resources` —
documented in `lib/repository/contract.js`. The static modules under `data/` are the first
implementation, not the interface; `LEADINTEL_REPO` picks the driver.

| driver | serves |
| --- | --- |
| `static` (default) | the authored modules under `data/` |
| `ingested` | canonical entities from the raw store, falling back to `static` per resource |

`LEADINTEL_REPO=ingested` is the proof that the swap works: every screen renders with no
view change and no schema warning, Campaign Analytics and Lead Intelligence answer from
ingested entities, and every other screen is served by `static`. It prints its own coverage
at boot — how many entities it has and which row fields it could not derive. Fields it
cannot compute render as `—` rather than borrowing the authored value, so an ingested
screen never blends the two. See `lib/repository/projections.js`.

Each resource has a schema in `schemas/`, derived by `tools/derive-schemas.js` from the
field inventory the converter already writes into `data/generated/`. In development every
payload is checked against it — both what the repository returns and what each view is
handed — and mismatches are reported once per resource on the console. The check wraps the
contract rather than any one driver, so a database-backed implementation that returns a
differently-shaped row is caught rather than rendering as a blank cell. Set
`LEADINTEL_SCHEMA_CHECK=off` to silence it; it is off in production regardless.

Two limits worth knowing. The check can only see fields the converter declared — the
report builder's `canvasWidgets` rows are looped over for `bars` and `rows` that are not in
its inventory, and nothing there is verified. And extra keys are ignored, so it catches a
missing or wrongly-shaped field, never a superfluous one.

## Ingest

Stages 1–2 of the Analytics Engine pipeline, in `lib/ingest/`. **Phase 4 is complete** —
all six sub-phases, including the driver that puts ingested data on screen.

```js
const ingest = require('./lib/ingest');
await ingest.syncAll();          // pull every source into var/raw/
const { bookings } = ingest.snapshot();   // rebuild entities from the store alone
```

The sync loop runs in-process when the server starts, polling each source at its own
cadence and recording every attempt to `var/runs.jsonl`. Set `LEADINTEL_SYNC=off` to
silence it.

| | |
| --- | --- |
| `GET /ingest/status` | per source: last success, lag, health, failures — plus the stage 3 `match` rate |
| `POST /ingest/webhook/:source` | intake for the two sources that stream — `{ kind, body }` |
| `GET /workspace/attribution` | the active model, its credit split, history — `?candidate=` adds an impact preview |
| `POST /workspace/attribution` | apply a model — `{ model, justification }`; `custom` requires a reason |
| `GET /metrics` | the registry, evaluated in dependency order — `?id=` for one definition, `?at=campaign:<key>` for a grain |
| `GET /metrics/coverage` | how many KPI cards resolve to a registry entry, and which do not |
| `GET /metrics/definitions` | per-metric version, when it changed and by whom — `?id=` for one metric's history |
| `GET /metrics/:id/explain` | a six-step explanation over two windows — `?over=7d&against=30d` |
| `GET /rules` | the eight alert rules, each with state, cadence, 90-day fire count and false-positive rate |
| `POST /rules/evaluate` | evaluate now; fires deliver and are recorded |
| `GET /rules/fires` · `POST /rules/fires/:id/judge` | fire history; mark one a false positive |
| `GET /login` · `POST /login` · `POST /logout` | sign in and out |
| `GET /whoami` · `GET /audit` | the caller's identity and permissions; the workspace's audit trail |
| `GET /schedules` · `POST /schedules/run` | the five report schedules, when each next runs; run those that are due |
| `POST /metrics/snapshot` | record an evaluation with the entities it read — `{ note, at }` |
| `GET /metrics/snapshots` | recorded evaluations, newest first — `…/:id` for one, `?inputs=1` for its inputs |
| `GET /metrics/snapshots/:id/reproduce` | re-run the stored inputs and report whether the number still holds |
| `POST /reports/send` | record that a report went out — `{ report, metrics, recipients, channels, at }` |
| `GET /reports/dispatches` | sent reports, each with its restatement status — `…/:id` for one |

The attribution model is a **workspace setting**, not a per-screen control: it is threaded
into every repository read and persisted in `var/workspace.json`. Selecting a model on the
Attribution screen previews its impact; applying it is a separate, deliberate POST that is
recorded with a reason. See `lib/attribution.js`.

Health is a multiple of each source's own cadence rather than a fixed number of minutes:
`ok`, `lagging` past 3×, `down` past 6×. A source that has never synced reads
`never-synced` with a `null` lag — not zero, which would read as current.

> **None of this makes any number on screen more real.** There are no credentials for Meta,
> Google, TeleCRM, the PMS or Razorpay, so every connector reads synthetic fixtures under
> `lib/ingest/fixtures/`. Nothing ingested reaches a screen yet — that is sub-phase 4.6.

The network call is a *transport* a connector is handed, not something it contains, so a
connector reads fixtures today and a live API the day a token exists with nothing
downstream able to tell the difference. `LEADINTEL_TRANSPORT=http` selects the live one,
which throws with its reason: writing a speculative client for five APIs whose auth,
pagination and rate limits cannot be tested would be five guesses dressed as progress.

Payloads are stored immutably in `var/raw/` and everything downstream is rebuilt from them,
so a sync is replayable and idempotent. Normalisation covers the five rules the design
names — currency, timezone, casing, phone to E.164, campaign-name cleanup — plus calendar
dates, which must *not* be timezone-converted; see PHASES.md 4.3 for why. Where the PMS,
CRM and gateway disagree about a booking, the precedence rules decide, and the losing value
stays on the record.

## Metric registry

Stage 5, in `lib/metrics/`. One definition per KPI, each carrying all twelve fields the
Analytics Engine specifies — id, name, description, formula, sources, refresh, owner,
dependencies, benchmark, thresholds, favourability, ai_context. `assertMetric` refuses an
incomplete definition **at load**, so the module throws on require rather than at first use.

```js
const metrics = require('./lib/metrics');
const { metrics: rows } = metrics.report(require('./lib/ingest').snapshot());
```

24 metrics — base ones read canonical entities, derived ones are arithmetic over those.
Formulas are expressions over metric ids — never SQL, never `eval`. Calculation order is a
topological sort of the dependency graph, not the order definitions are written in.

Two evaluator rules worth knowing before adding a metric: **division by zero returns
`null`, not `Infinity`** (a ROAS with no spend is unknown, not infinitely good), and **an
unknown input makes the whole expression unknown** rather than carrying a zero through.
Money is in paise; `format` divides, arithmetic does not.

A KPI card names the metric it *is* (`metric: 'roas.net'`). The definition then travels with
the card under every driver; the **value** is replaced by the registry's own only under
`ingested`, where it is genuinely derived. Each card records which it got in `valueSource`.

### Versioned results

An evaluation can be recorded with **the entities it read**, not just what came out — a
stored figure with no inputs is a claim, one with its inputs is a receipt. `reproduce`
re-runs the stored inputs through the current evaluator and separates two answers that need
different responses:

- `reproduced: false` with `registryChanged: false` — the same inputs give a different
  answer under unchanged definitions. That is a bug.
- `registryChanged: true` with `definitionDrift` naming the metrics — somebody edited a
  definition. That is a restatement.

The fingerprint covers formula, dependencies, thresholds, benchmark, favourability, format,
refresh and owner — not `description` or `aiContext`, so rewording a sentence never reads as
a restatement. Records live in `var/evaluations/`.

### Sent reports and restatement

A dispatch records that a report went out **carrying particular figures** — copied out of an
evaluation snapshot, not referenced, so a recipient's copy never changes because a store was
replayed. When the numbers move underneath it, the report is **flagged, never rewritten**:

- `dataMoved` — same definitions, different number. The source restated; reissue.
- `definitionMoved` — the metric now means something else. The old report is not wrong;
  explain rather than reissue.
- `unreproducible` — the metric has left the registry entirely.

Only the metrics a report actually showed are tracked, and each dispatch is compared at its
own grain. Restatements surface in the notification panel as critical, because somebody is
holding a number the product no longer agrees with. Records live in `var/dispatches/`.

> Nothing is actually sent — no mail transport, no PDF renderer, no scheduler. Those are
> Phase 8. `send` records the fact of a dispatch, which is what restatement flagging needs.

### Grains

A metric means the same thing at every grain, so the **entities** narrow rather than the
definitions. Because derived metrics are arithmetic over base metrics, scoping the entity
set scopes the whole graph — a campaign's ROAS is its own revenue over its own spend without
`roas.net` knowing campaigns exist. A screen declares its grain with `metricScope`.

Not every metric is meaningful at every grain: occupancy per campaign is nonsense, and a
metric whose collections cannot *all* be narrowed by the dimension comes back **not
applicable** rather than zero or a reused workspace figure.

```
GET /metrics?at=campaign:munnar%20honeymoon%20jul
GET /metrics?at=property:Munnar%20Hillside
```

### Definition versions

Each metric carries its own version, advancing only when **that** metric changes. Definitions
live in code, so the log reconciles at boot — comparing what is in force against what was
last recorded — and records *which fields* moved, since a shifted threshold and a rewritten
formula are different events. Rewording `description` or `aiContext` mints nothing.

`author` is recorded when supplied and reads `unattributed` otherwise: the app cannot see who
edited a source file, and a governance record naming the wrong person is worse than one
naming nobody. Real identities arrive with Phase 9.

### Periods

A card may name the window it is about (`period: 'last-24h'`). Like a grain, a period narrows
the **entities**, so `leads.count` over 24 hours is the same definition rather than a new
metric. Which date a record belongs to is declared per collection in `lib/metrics/period.js`
— notably **a booking belongs to the night stayed, not the day booked**, so revenue lines up
with the inventory rows occupancy and RevPAR are computed from.

The reference instant is passed in at the edge and never read inside the metric layer, so
evaluation stays a pure function of its inputs and remains reproducible.

> **Coverage is 47 of 88 KPI cards (53%).** Phase 6 was closed by decision at 43%; Phase 8
> raised it by binding the scorecard, builder canvas and presentation slide to the registry.
> The remaining 41 are not missing definitions, they are **missing data**: 15 need a system
> nobody has connected (web analytics, ad reach, total marketing cost, call logs), 16 sit
> inside the AI screen's authored narrative (Phase 7), and 10 need entities canonical does
> not build. `GET /metrics/coverage` names every one. Raising this needs a new source
> connected, not more code, and no card has been given a fabricated formula to improve the
> figure.

## Explanations

Stage 7, in `lib/ai/`. **There is no language model.** The requirement is that explanations
read the same registry as the dashboards, so they cannot disagree with the number on screen —
every claim is derived from a registry evaluation and carries the metric and window it came
from. `assertSourced` enforces that on every explanation, and one that cannot be sourced is
withheld rather than shipped with a warning.

```
GET /metrics/roas.net/explain?over=7d&against=30d
```

Six steps: state the change (both windows named, direction read through favourability),
decompose the drivers (shares that sum to the whole move), name related metrics (off the
dependency graph), say whether it is efficiency or composition, recommend with an expected
value, declare confidence and sources.

Two rules are enforced, not intended: **unquantifiable drivers are declared rather than
estimated** — a base metric has no decomposition and says so — and **confidence below 60%
suppresses the recommendation** inside the layer, showing the gap instead.

`LEADINTEL_REASONER=model` selects a model-backed reasoner, which throws with its reason:
no API key, no reviewed prompt, no evaluation that generated prose would meet the six-step
contract. It would have to pass the same provenance checks as the deterministic one.

## Creative scores

Creative Intelligence carries two numbers that are **this product's own, not Meta's** —
Meta publishes no fatigue metric, and its nearest equivalent ranks an ad against competing
ads rather than against its own history. Both are defined on the screen next to the cards
that show them, because a score nobody can interpret gets quoted in a meeting and acted on
anyway.

**Fatigue** (`lib/creative-fatigue.js`) is 0–100, a creative against *itself*: frequency,
click-through decay over the last 7 days against everything before them, and CPM rise over
the same comparison. Each signal is capped, so a creative is called worn out because several
things agree. Under 14 days of usable history it scores **nothing at all** — unknown is
never healthy, and a green zero would be a confident wrong answer. Thresholds are ad-ops
consensus with the sources named in the file, not a vendor specification.

**Action** (`lib/creative-verdict.js`) is the instruction — Stop, Refresh, Review, Keep
running, Scale, or Not enough data — and it is what the screen was missing: fatigue said
something was wrong and left the reader to decide what to do about it. It weighs fatigue
against cost per lead **compared to the account's median** (not the mean — one ad burning 4×
the rate would drag a mean up until everything else looked efficient beside it), because
₹2,000 a lead is cheap for a suite and dear for a day pass. Stop at **1.5×** the median,
Scale at **0.75×** or below with fatigue healthy. Every verdict carries the numbers that
produced it.

**Fatigue and the verdict are separate judgements.** A creative with no fatigue reading can
still be judged on cost, so `Fatigue —` beside a real instruction is correct, not a bug.

**But an expensive creative with no fatigue reading is *Reviewed*, never Stopped.** No
reading means under a fortnight of usable history, which puts the creative at or near Meta's
learning phase — an ad that looks dear in week one routinely settles by week three, and
turning it off is the mistake every media buyer is warned about. The instruction says what is
known and stops short of the decision.

Under three leads there is no cost per lead, under three peers there is no median, and either
gap reaches *Not enough data* rather than any confident answer.

**Within one action, the biggest spender leads.** Ranking cheapest-lead-first inside a group
is right for Scale and backwards for Stop — it put the creative wasting the least above the
one wasting the most. Spend is the one tiebreak that reads correctly everywhere, because it
is not a judgement about the creative at all: it is how much money is riding on the decision.

**Funnel stage** (`lib/creative-funnel.js`) is read from the **ad set's targeting**, on
audience recency: no custom audience is *Top* (cold), an audience with a retention window
over 30 days is *Middle* (warm), 30 days or under is *Bottom* (hot). An ad set on several
audiences takes the shortest window — the hottest audience decides how it behaves.

It read the campaign objective first, which was wrong for the commonest case: an account can
run its entire funnel under one `OUTCOME_LEADS` objective, and most lead-gen accounts do, so
every creative read "Bottom of funnel" and the badge said nothing. Targeting is not a looser
signal — it is a *fact about how the ad set was built*, unlike frequency or audience size,
which are performance readings and would be an inference wearing a label.

Three signals in order, and **the tooltip says which one answered**, because a stage read
from a retention window and one read from an ad set's name are not claims of equal strength:
targeting → ad set name (`Broad | Kerala`, `All 60 Days KL`, `30 Days 75% Watchers` all say
it outright) → campaign objective. Nothing readable is declined: a creative in the wrong part
of the funnel is worse than one in none.

The three views the design draws — Gallery, Leaderboard, Timeline — **re-rank the same
cards**; the design gives the other two a label each and no markup, and inventing a table and
a Gantt would mean hand-writing layouts into generated views.

## Running it for real

```
LEADINTEL_SECRET=...     signs session cookies (required in production)
LEADINTEL_TLS=on         enables HSTS and the Secure cookie flag (required in production)
LEADINTEL_PROXIES=1      how many proxy hops to trust, for rate-limit keying
NODE_ENV=production      refuses to start if any of the above is wrong
```

**Production refuses to start misconfigured rather than warning about it** — a warning in a
startup log is read once, by the person who already knew.

`GET /health` is public (a load balancer cannot present credentials) and carries no tenant
data: per-route p50/p95/p99/max and whether each is inside the design's 200 ms budget.
Percentiles come from kept samples, not a running average — a mean hides exactly the tail a
budget is about.

**Backups.** `var/` is the only state that cannot be recreated by running the app again.

```
npm run backup           take one
npm run drill            back up, DELETE var/, restore, verify the entities match
```

The drill is the point: *a backup exists* and *a restore succeeds* are different claims, and
a restore tested without first destroying anything tests nothing.

> **Measured:** 1,344 requests from 8 concurrent users across all 13 screens — worst p95
> **62 ms** against a 200 ms budget. Cold restore drill passes: 17 files, no checksum
> mismatches, entities identical either side of the wipe.
>
> **Not done:** no deploy target, no TLS, no database. Every store is file-backed and
> process-local — correct for one node, wrong for several. Sessions, the rate limiter and
> the sync schedule all want the same shared backend the day a second instance exists.

## Auth, tenancy and permissions

Everything but `/login` and `/assets` needs a session. `lib/auth/` holds identity,
permissions, sessions and the audit log.

**The raw store is partitioned per workspace** — `var/raw/<workspace>/`. Isolation is a
property of where the data is, not of a filter on the way out, so a tenant with no data gets
an empty store rather than somebody else's. **`req.workspace` comes from the session, never
from the request**: a `?workspace=` that is *checked* is still a parameter somebody will one
day forget to check.

Two gates are the design's own words — *attribution changes are Owner and Marketing Director
only*, *custom metric edits are Owner plus Analyst* — and six more follow the roles it names.
**Deny by default**, including for actions that do not exist. **Refusals are audited as well
as successes**, because a success-only log never answers "who tried".

```
LEADINTEL_SECRET=...        signs session cookies; without it, sessions end at restart
LEADINTEL_AUTH=off          serve as Owner with no sign-in (refused in production)
```

> Six **seeded** users across two workspaces, all sharing the password `leadintel`, printed
> on the sign-in page. They are fixtures, not people — no registration, no reset, no email.
> Passwords are still scrypt-hashed and compared in constant time, because the first real
> account will arrive through the same door.
>
> Sessions are in memory: correct for one process, wrong for several. That moves to a shared
> store in Phase 10.

## Alert rules

The eight rules in `lib/rules/` are the Analytics Engine's own alert table. Each watches a
registry metric and evaluates on **that metric's cadence**, so a rule can never reference a
number the dashboards do not also show.

`evaluate` returns three states, not two — **fired, held, or unevaluable**. Three of the
eight cannot be computed at all (no forecast metric, no fatigue score, no plan series) and
say so, because a rule nobody can compute is not a rule whose condition was not met.

Email, Slack and WhatsApp are configured by the design and none can be reached; each reports
why and does not block the others. **`log` is always attempted**, and recent fires appear in
the notification panel — a rule that fired where nobody could see it would satisfy the letter
of "end-to-end" and miss the point.

**A false positive is never inferred.** It is recorded when a human marks one, and a rule
with no reviewed fires reports its rate as *unknown* rather than 0% — claiming zero for an
unreviewed rule would flatter exactly the thresholds that need watching.

`LEADINTEL_ALERTS=off` silences rule evaluation without stopping ingest.

## Report schedules

`lib/schedules.js` holds the design's five schedules, each with a structured cadence beside
its human string — the prose is never parsed at runtime. Every cadence is **IST**, stated
rather than inherited from the server. **Due-ness comes from the last dispatch, not a
timer**, so a process down over Monday morning still sends Monday's report.

The Reservations pace schedule is paused in the design and paused here — running it because
the machinery could would be the product overriding a person.

## The converter

`views/screens/*.ejs`, `data/generated/*.js` and `public/assets/hover.css` are all produced
from the design file:

```
node tools/dc-to-ejs.js "path/to/LeadIntel App.dc.html"
```

It is deterministic — re-run it when the design changes rather than editing the output. It
translates the Claude Design authoring constructs, none of which are valid HTML:

| Design | Becomes |
| --- | --- |
| `<sc-for list="{{ xs }}" as="x">` | `<% (xs \|\| []).forEach(function (x) { %>` |
| `<sc-if value="{{ c }}">` | `<% if (c) { %>` |
| `{{ expr }}` | `<%= expr %>` |
| `style-hover="…"` | a generated class in `hover.css` (13 unique declarations, 108 uses) |
| `onClick="{{ fn }}"` | `data-action="fn"` — preserved for wiring, not a live handler |
| `hint-placeholder-count` | dropped |
| `hint-placeholder-val` | the boolean default for that `sc-if` flag (see below) |

It also derives each screen's **exact data shape** from the markup — every key the view
reads and every field of every list item — and writes it to `data/generated/`. Nothing is
invented: the values are empty, but the shape is the design's.

Two details worth knowing:

- **`sc-if` defaults come from the design.** `hint-placeholder-val="{{ true }}"` tells us
  which sub-tab the designer had open and which drawer was closed. Defaulting every flag to
  `false` renders a blank screen, so the generated shape uses the design's own value.
- **Truncated screens are balanced, not broken.** `sales` was cut mid-block, leaving two
  unclosed `sc-if`s. An unclosed `forEach`/`if` is an EJS syntax error, not a layout glitch,
  so the converter closes them and appends a visible "incomplete" notice.

## Why the content is authored

`DesignSync.get_file` caps reads at 256 KiB and has no offset parameter.
`LeadIntel App.dc.html` is larger, so the copy fetched through the MCP came back truncated:

- The markup survived almost intact — 12 of 13 screens converted complete; only Sales
  Analytics was cut, and it renders an on-screen notice saying so.
- **The entire `<script data-dc-script>` data block is missing.** That is where the values
  for all 105 `sc-for` loops live: KPI figures, campaign names, chart series, table rows.

Reading the same file **from disk** has no cap, so exporting it from claude.ai/design and
re-running the converter would fill all of that in. It was never exported, across six
sessions of asking, and **Phase 1 was closed on 2026-08-06 with the authored content
permanent**. `LeadIntel Design System.dc.html` was checked as an alternative source — 58.9 KB,
read complete — and carries no `navGroups`.

Permanently unfinished as a result, and not defects to be filed:

- Every figure under `data/` is authored, bar the two marked as design content.
- The sidebar `group` and `icon` per screen are stand-ins, flagged in `data/screens.js`.
  Screen **names** are real — taken from each screen's own `<h1>`, which did come through.
- `views/screens/sales.ejs` is truncated.

If the file ever lands, none of this blocks using it:

```
node tools/dc-to-ejs.js "<path to the exported file>"
npm run rebind && npm run schemas
```
