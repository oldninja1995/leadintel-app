# LeadIntel — phased delivery plan

Getting from the current state (a faithful UI shell) to a working product. Phases are
ordered by dependency, not by appetite: each one is only startable once the one before it
has cleared its exit criteria.

The metric-layer phases are not invented — they are specified by the **Analytics Engine**
page, already implemented at `C:\Users\water\projects\leadintel-analytics-engine`. That
page is the contract for Phases 4–7 and should be read before starting them.

---

## Status

| Phase | Name | State |
| --- | --- | --- |
| 0 | Design import & UI shell | **done** |
| 1 | Content | **closed** — authored by decision, permanently. Numbers are not real |
| 2 | Interaction completeness | **done** |
| 3 | Data access layer | **done** |
| 4 | Ingest & normalisation | **done** |
| 5 | Identity resolution & attribution | **done** |
| 6 | Metric registry | **closed** — 6.1–6.3, 6.5 done; 6.4 at 53%, the data ceiling |
| 7 | AI reasoning layer | **done** — deterministic; a model-backed one is stubbed |
| 8 | Alerts, reports & scheduling | **done** — one deferral: no slide deck to step through |
| 9 | Tenancy, auth & permissions | **done** |
| 10 | Hardening & deploy | **done** — both exit criteria met; deploy target still unchosen |

---

## Phase 0 — Design import & UI shell · done

All 13 screens, the app chrome, 32 sub-views in 9 groups, both overlays, and a
deterministic converter (`tools/dc-to-ejs.js`) that regenerates views, data shapes and
hover CSS from the design file.

**Exit criteria — met.** Every route returns 200; every screen and sub-view is reachable;
no view is hand-edited, so a design change is one converter run away.

---

## Phase 1 — Content · closed, authored by decision

**Goal.** Every `sc-for` region renders real rows. Met — no empty table, list or chart
remains on any screen or sub-view.

**Read this before trusting any number on screen.** The content is **authored, not
transcribed from the design**. The original plan was to transcribe the design's own data
block; that block never arrived, because `DesignSync.get_file` caps reads at 256 KiB and
`LeadIntel App.dc.html` exceeds it. Rather than stay blocked, the data modules under
`data/` were written to be internally consistent with the facts the design does state in
its own hardcoded markup — ₹52.3L July revenue, a 38/27/19/16 source split, 78% occupancy
against an 82% target, a 16.1% lead→check-in rate, an August forecast of ₹61.0L, campaign
health 92 at ₹3,000/day. Every module carries an `AUTHORED` header.

Two things are **not** authored and can be trusted as design content:

- The seven attribution models' channel credit in `data/attribution.js`, taken verbatim
  from the Analytics Engine page's impact-preview table.
- The AI narrative in `data/ai.js`, which follows that page's six-step explanation
  contract and reuses its worked example (Net ROAS 4.2x → 4.8x, driven 58/27/15).

**Closed by decision on 2026-08-06.** The design file was never exported to disk across six
sessions of asking, and there is no other route to it: `DesignSync.get_file` is capped at
256 KiB with no offset parameter, and `LeadIntel Design System.dc.html` — checked, 58.9 KB,
read complete — carries no `navGroups`. So the authored content **is** the content, and the
plan stops waiting on a file that is not coming.

This changes the plan's status. **It changes nothing about the numbers.** Every
`AUTHORED` header stays, the README warning stays, and none of these figures may be quoted
to anyone as real or as the design's. A decision to stop waiting is not a decision that
invented data became true.

**Three things stay permanently unfinished, and are not defects to be filed:**

- Every figure under `data/` except the two noted above is authored.
- `data/screens.js` sidebar `group` and `icon` are stand-ins. The design supplies them
  through `navGroups`, which sat in the part of the file past the read cap.
- `views/screens/sales.ejs` is truncated and renders an on-screen notice saying so. The
  markup past the cut was never received.

**If the file ever does turn up**, nothing about this decision blocks using it:

```
node tools/dc-to-ejs.js "<path to the exported file>"
npm run rebind && npm run schemas
```

Reading from disk has no cap. That regenerates `data/generated/` with the design's real
shapes and completes Sales Analytics; the `data/<view>.js` modules shallow-merge over the
generated layer, so authored content can be replaced file by file rather than all at once.

---

## Phase 2 — Interaction completeness · done

**Working.** Sidebar navigation and collapse; all nine tab strips; both overlays; the
twelve named navigations (`goPipe`, `backToLeads`, `closeCr`, …); and now:

- **Row drill-through** — lead rows open the profile, campaign rows open the drill-down,
  ad-set rows open the ads tab, creative cards open the drawer, report rows select a
  report. Data rows carry their own `go` destination, which the converter's item-scoped
  `data-action` evaluates per row.
- **Attribution model switching genuinely re-credits revenue.** Selecting any of the
  seven models re-renders channel credit and share from the Analytics Engine's own
  impact-preview table — first click puts Meta at ₹24.1L, last click drops it to ₹14.1L
  and lifts Direct to ₹19.9L. This is the behaviour that page specifies.
- **The simulator computes.** A fixed answer regardless of inputs would be worse than
  useless in a what-if tool, so `data/ai.js` carries a small model: incremental Meta spend
  at 4.6x net degraded 15% for marginal return, bookings moving with revenue at the
  ₹31,400 average deal, and a shorter payment window recovering cancelled revenue.
  Confidence falls as levers move from baseline. With every lever at baseline it returns
  exactly the observed figures (₹52.3L, 4.8x, 312, 3.4%) at 94% — the anchor check.
- **Segmented controls hold state in the URL** — revenue granularity, summary and forecast
  ranges, benchmark mode. Every selection survives a refresh and is shareable.

**The known flaw is fixed** (2026-08-06). The attribution Sankey's node labels were
hardcoded in the design's own markup, so they read ₹18.9L whatever model was selected while
the table below re-credited correctly — the diagram contradicting the table on the same
screen, and most visibly so during a 5.2 preview.

It was recorded as blocked on the design export, on the reasoning that making the diagram
data-driven is a design change. That was wrong: the design draws the Sankey as a hand-written
SVG, so its figures are literal text rather than `{{ }}`, and **binding a literal to an
expression is a conversion concern**. `tools/literal-bindings.js` holds the table,
`tools/dc-to-ejs.js` applies it during conversion, and `tools/rebind.js` applies the same
function to views generated before the bindings existed.

That last part is what keeps the rule intact. `views/screens/` is still never hand-edited —
the change is made by the converter's own code, so a re-run against the real design file
reproduces it rather than reverting it. A binding must match its literal **exactly once** or
it throws, because first-match-wins would bind the wrong node with nothing to show for it.

*Verified.* Under Data driven the Sankey reads ₹18.9L and the table ₹18.9L; under First
click both read ₹24.1L; under Last click both read ₹14.1L — including while previewing,
where the diagram would otherwise contradict the preview bar above it. 10 tests in
`test/bindings.test.js`.

**The three that were open are now built** (2026-08-05). Each was open for a different
reason, and only one of those reasons was code.

- **Command palette (⌘K)** — `lib/palette.js`, `views/app/palette.ejs`,
  `public/assets/app-ui.js`. The design turned out to declare the *trigger* twice —
  the sidebar and top-bar search boxes both carry `data-action="openPalette"`, and the
  top bar even renders a ⌘K hint — and only the surface was missing. So the entry points
  are the design's and the panel is mine.

  The index holds no list of its own: entries are derived from the repository's screen
  registry and the converter's sub-view map, so a screen the design does not declare
  cannot appear and one it adds later appears without the file changing. Default
  sub-views are skipped, or they would be a second row to the same URL. Search matches
  all terms in any order, and a sub-view carries its screen's name in its search terms —
  "pipe kanban" and "kanban pipe" both find it.

- **Notification panel** — `lib/alerts.js`, `views/app/notifications.ejs`. Trigger again
  the design's own (`data-action="toggleNotif"`, with a hardcoded badge of 4 that the
  enhancement now replaces with the real count, and removes at zero).

  The panel is mine but **its contents are not invented**. Two real sources: connector
  health straight off the 4.5 run log, and the normalisation problems 4.3 collects
  rather than drops. The Analytics Engine's business alert rules — pace, ROAS decay,
  response-time breach — are Phase 8 and deliberately absent. An empty panel is the
  honest state when nothing is wrong; padding it with samples would make the real ones
  unfindable the day they matter.

- **Filter chips** — `lib/filters.js`, applied in `server.js` between the repository and
  the view. The old note said this needed Phase 3, which is now done — but Phase 3 built
  a repository, not a second data snapshot per screen, and that distinction is the whole
  design here.

  A chip narrows a collection when **every** row in it carries the field that chip names
  (`leadRows` carry `property`, campaign rows carry `platform`). It never recomputes a
  total, scales a chart, or invents a subset figure — and the shell says so, above the
  screen, every time a filter is active: *"1 table narrowed, 4 rows hidden. Totals and
  charts are **not** filtered."* Silently shrinking a table while leaving the headline
  KPI above it unchanged is exactly the lie the original decision refused to tell, and
  the note exists to prevent it.

  Chip options come from the rows themselves, so no dropdown offers a value the data does
  not contain. `Booking window` stays inert and says why when opened — no row carries one.

Covered by 22 tests in `test/chrome.test.js`, most of which assert what filtering does
*not* touch. Verified in a real browser: ⌘K opens and arrow-keys navigate, the panel
renders five never-synced connectors against an empty run log, and
`/leads?f_property=Munnar Hillside` narrows the table from seven rows to three.

**Still open from the original scope.** Whether the app stays server-rendered with URL
state or takes a client framework. The `?v=` routing has held up well and is shareable;
the weak point is that opening a drawer costs a full page load.

---

## Phase 3 — Data access layer · done

**Goal.** Screens read from a data service, not from static modules.

**The read API** is `lib/repository/contract.js` — five asynchronous calls (`screens`,
`navigation`, `subviewGroups`, `read`, `resources`) that between them answer everything a
request needs. Asynchronous by decision, not by need: the static implementation could
answer synchronously and a database-backed one cannot, so the contract takes the slower
shape and a swap does not become a caller rewrite.

**The implementation** is `lib/repository/static.js`, and it is now the only file in the
app that reaches into `data/`. `LEADINTEL_REPO` selects the driver; there is one today.
Two things moved out of `server.js` to get there: the generated/override merge, which is a
property of this implementation rather than of the contract, and sub-view resolution,
which is request state rather than content and now lives in `lib/view-state.js`.

**The schemas** are `schemas/<resource>.json`, derived from the generated shapes by
`tools/derive-schemas.js` (`npm run schemas`, re-run after every converter run). The
generated modules already state each screen's keys and each list's row fields in comments;
the tool turns those comments into something checkable. `lib/schema.js` checks every
payload against them in development — repository reads, where keys the route supplies are
allowed to be absent, and the payload handed to each view, where nothing may be missing.
The check wraps the contract rather than any one driver, so a new driver inherits it, and
it is off in production and behind `LEADINTEL_SCHEMA_CHECK=off`.

**Exit criteria — met.** No view imports a data module, and neither does any route: the
only references to `data/` above the static driver are in comments. Swapping drivers
requires no view change — verified by registering a second driver that answers from a JSON
snapshot with no access to `data/` and no `select`, and rendering 16 pages on both: byte
for byte identical, no view or route touched. All 52 URLs (every screen, every sub-view
flag, both overlays, the seven attribution models, the 404) still return their expected
status.

**What the schema check found on its first run.** Two real gaps, both since fixed. The
sidebar declared a `badge` field that nothing supplied. And every canvas widget on the
report builder is a discriminated union of six `is*` flags the view branches on, but each
widget declared only its own — a mistyped flag would have rendered an empty card in
silence; they are now built through a `widget()` helper that fills all six. Fixing the
second surfaced a third: the funnel and table widgets on that canvas read `w.bars` and
`w.rows`, which nothing supplied, so both had been rendering as empty cards. They now
carry content mirroring the executive dashboard.

**One limitation of the contract itself.** `bars` and `rows` are *not* in the generated
field inventory for `canvasWidgets` — the converter did not emit them, though it does emit
nested shapes elsewhere (`.chips[]`, `.items[]`, `.channels[]`). So the schema cannot
catch a fault in them. Anywhere a view loops over a field the converter missed, the check
is silent by construction; it is a floor on shape correctness, not a ceiling.

---

## Phase 4 — Ingest & normalisation

Implements stages 1–2 of the Analytics Engine pipeline.

**Goal.** Real data arrives and is stored in a consistent shape.

**Scope.** Connectors for Meta Ads, Google Ads, the CRM (TeleCRM), the PMS and the payment
gateway. Scheduled pulls plus webhook streams. Raw payloads stored immutably so ingestion
is replayable. Normalisation: currency, timezone, casing, phone to E.164, campaign-name
cleanup. The precedence rules are specified — PMS wins revenue and booking status, CRM
wins lead and campaign IDs, ad platforms win spend and delivery, gateway wins payment.

**Depends on.** Phase 3 — done, so this is the next phase to start.

**Exit criteria.** Every source syncs on its stated cadence. A source can be replayed from
raw storage and produce identical output. Precedence conflicts resolve per the rules, with
the losing value retained.

### The constraint that shapes this phase

There are no credentials for any of the five systems, and no account to get them from. So
the phase splits along that line: everything except the network call can be built, tested
and finished now, and the network call is a transport each connector is handed rather than
something it contains. A connector reads fixtures today and a live API the day a token
exists, and nothing downstream of it can tell the difference — the same argument as the
repository swap in Phase 3, applied a layer lower.

Fixtures are synthetic and labelled as such, exactly as the authored content under `data/`
is. Nothing in this phase makes any number on screen more real.

### Sub-phases

| | Name | State |
| --- | --- | --- |
| 4.1 | Source registry & connector contract | **done** |
| 4.2 | Raw store & replay | **done** |
| 4.3 | Normalisation | **done** |
| 4.4 | Canonical entities & precedence | **done** |
| 4.5 | Sync runner, cadence & lag | **done** |
| 4.6 | Repository driver over ingested data | **done** |

All six sub-phases are covered by 66 tests — `npm test` (88 across the project). Everything
below describes what was built against each sub-phase's exit criteria.

**4.1 — Source registry & connector contract · done.** `lib/ingest/contract.js` defines a
source (id, system, cadence, record kinds, the precedence fields it wins) and a connector
(`pull(window, transport)`, `receive(event)`). `lib/ingest/sources.js` registers the five.
The six precedence rules live in the contract rather than in the merge code, because which
system is authoritative for a field is the same fact as which fields a source wins — and
registration checks one against the other, so a source cannot claim authority it does not
have. `lib/ingest/transport.js` holds the fixture transport and the live one, which throws
with its reason rather than pretending.
*Exit — met.* Five sources, five connectors, and a test asserting the precedence table
field for field against the Analytics Engine page.

**4.2 — Raw store & replay · done.** `lib/ingest/raw-store.js` — append-only JSONL under
`var/raw/<source>/<kind>.jsonl`, keyed on (source, kind, external id, checksum). A re-pull
of an overlapping window writes nothing; a payload that has genuinely changed appends
beside its predecessor rather than over it, so a restatement can be traced to the delivery
that caused it. Checksums are order-insensitive, or a source that serialises inconsistently
would look changed on every pull.
*Exit — met.* Syncing twice under different clocks produces identical entities, and
`replay` strips `fetchedAt` on the way out so nothing downstream can depend on it.

**4.3 — Normalisation · done.** `lib/ingest/normalise.js` — the five rules, each pure, each
returning `{ value, raw }` and never throwing. An unreadable value comes back as
`{ value: null, raw, problem }` and is collected rather than dropped: silently discarding
a bad row is how a source ends up 3% short with nobody the wiser.
*Exit — met.* Covered: Indian digit grouping, lakh and crore notation, Google's micros,
the gateway's paise, all four Indian phone formats, and IST-to-UTC across a date boundary.

A sixth rule turned out to be necessary. A **calendar date is not an instant**: a day of
ad spend or a night of inventory is a whole day in the source's timezone, and pushing it
through the timezone rule moves 2026-07-14 IST to an instant of 2026-07-13T18:30Z — read a
date back off that and every daily figure in the product is a day out, invisibly, because
the number is still plausible. The first implementation had exactly this bug and the tests
caught it. Dates now go through `date()` and keep their calendar day; only instants get a
timezone.

**4.4 — Canonical entities & precedence · done.** `lib/ingest/canonical.js` maps each
source's payloads to typed fields, then groups them into `campaignDay`, `lead`, `booking`
and `payment`. Only `booking` is contested — three systems have a view of it — so it is
the only entity that goes through `lib/ingest/precedence.js`, which resolves each field
separately and keeps the losers on the record.
*Exit — met.* B-1001 settles at the PMS folio's ₹42,800 and still carries the CRM's
₹46,000 expectation, the rule that decided it, and a `disputed` flag. Retaining the loser
is the point: the ₹3,200 gap is a real fact about a discount or a dropped extra, and it is
what a revenue manager wants to see.

**4.5 — Sync runner, cadence & lag · done.** `lib/ingest/runner.js` — a `SyncRunner` over
an append-only run log at `var/runs.jsonl`, plus `POST /ingest/webhook/:source` and
`GET /ingest/status` in `server.js`. The loop runs in-process on boot; `LEADINTEL_SYNC=off`
silences it.

The runner is built around staleness rather than a schedule, because stage 1's SLA
("realtime – 15 min") is a promise about how old the data may be, not about how often a job
runs. A source is **due** when its last *successful* sync is older than its cadence, so a
tick, a manual run and a catch-up after downtime are the same call at different moments,
and a process that has been down an hour resumes correctly instead of waiting out a fresh
interval. The clock is injected — a scheduler that can only be tested by waiting is one
that does not get tested.

Health is a multiple of each source's *own* cadence, not a fixed number of minutes: sixteen
minutes of silence from a 15-minute poll is normal and from a stream is an incident. Two
distinctions are load-bearing and both are tested. **A failure is not a sync** — it is
appended to the log, never thrown, so one dead source cannot cut the run short, and it does
not touch lag or clear the due state. **Never-synced is not zero lag** — `lag` returns
`null` and health reads `never-synced`, because a connector that has been failing for six
hours and one that was never asked look identical from a lag number alone, and only one of
them is an incident.

*Exit — met.* 15 tests in `test/runner.test.js`. Every source syncs on its own stated
cadence (300s wakes the two streaming sources and leaves the three pollers alone); lag is
measured and exposed at `/ingest/status`, which is the shape the Phase 8 "Connector down"
alert reads. Webhook intake goes through `ingest.receive`, so a streamed record and a polled
one are still indistinguishable downstream. Nothing here changes a number on screen — the
views read the repository until 4.6.

One deferral, stated rather than hidden: the loop is in-process, which is right for one node
and wrong for several, since two instances would both poll. It moves to its own worker at
Phase 10.

**4.6 — Repository driver over ingested data · done.** `lib/repository/ingested.js` plus
`lib/repository/projections.js`, selected with `LEADINTEL_REPO=ingested`. This is where
Phases 3 and 4 meet, and it is the first thing to actually *prove* the Phase 3 contract
swaps — until now that was an assertion about a design, not a demonstrated fact.

Three rules shape it, and the second is the one that matters.

**Structure stays the design's.** `screens`, `navigation` and `subviewGroups` come from the
static driver even under this one. Which screens exist and how the sidebar groups them is
not a fact about Meta or the PMS, and no amount of ingested data would ever answer it.

**Derive or decline — never borrow.** A field the entities cannot compute renders as `—`,
not as the authored value it is replacing. A row blending six ingested figures with three
authored ones, indistinguishably, would be worse than either alone. Campaign `status`,
`objective`, `health` and `pace` are properties of a campaign object the fixtures carry no
kind for; a lead's `score` and `prob` are model outputs belonging to Phase 7. All are
declined explicitly, which also keeps the schema passing — the shape is the design's and
does not bend to what the fixtures happen to hold.

**Thin is a true answer.** Five fixture campaigns where the authored module shows six, one
booking where it shows ninety-four. That is the correct output, not a gap to pad.

Revenue reaches a campaign only through the CRM lead — the ad platform never sees a booking
and the PMS never sees a campaign, so the lead is the only entity touching both. That is
the closed-loop join the Analytics Engine page specifies, running for real.

*Exit — met.* Every one of the 13 screens renders under `LEADINTEL_REPO=ingested` with no
schema warning and no view change, and the swap is visible: the static driver shows the
authored "Corporate offsite" campaign at ₹348 CPL, the ingested driver shows five derived
campaigns at ₹346. 23 tests in `test/ingested.test.js`.

One bug worth recording, because it was invisible rather than loud. **Canonical money is in
paise** — `normalise.js` stores the minor unit so a gateway working in paise and a PMS
working in rupees land on one scale, and `₹42,800` arrives as `4280000`. The first
projection formatted paise as rupees, so every figure on every ingested screen was a
hundred times too large *and still looked like a plausible hotel number*. It was caught by
comparing a derived CPL against the design's own hardcoded ₹348. There is now a regression
test asserting `money(4280000)` is not `₹42.80L`.

---

## Phase 5 — Identity resolution & attribution

Implements stages 3–4.

**Goal.** Ad spend joins to booked revenue, and revenue is credited across touchpoints.

**Scope.** Identity resolution on the key ladder — `coalesce(ad_id, phone_e164,
utm_campaign)` with a confidence score and a match-rate metric. Seven attribution models
(first click, last click, linear, position-based, time decay, data-driven, custom
weighted) as a workspace-level parameter on every revenue read, not a per-report toggle.
Changing it must preview its impact before applying, restate history, and record a written
justification.

**Depends on.** Phase 4.

**Exit criteria.** Match rate is measured and exposed. Switching model re-credits revenue
product-wide. Already-sent reports are flagged on restatement rather than silently
altered.

### Sub-phases

| | Name | State |
| --- | --- | --- |
| 5.1 | Identity resolution & match rate | **done** |
| 5.2 | Attribution as a workspace parameter | **done** |
| 5.3 | Restatement & report flagging | **done** |

**5.1 — Identity resolution & match rate · done** (2026-08-05). `lib/identity.js`, exposed
at `GET /ingest/status` and as an operational-health alert in the notification panel.

The page states this stage in one line — `join_key = coalesce(ad_id, phone_e164,
utm_campaign) · confidence ≥ 0.86` — and that line compresses two joins. Reading it as one
is how it gets built wrong. A booking must reach a *lead* before it can reach an *ad*: the
PMS knows a guest and a folio, the ad platform knows a campaign and an ad, and the CRM lead
is the only record carrying both. So the ladder scores how well each booking got connected,
and the rung names the **weakest link in the chain**, not the best fact available — a
booking found only by phone stays a phone-grade match even when the lead it found happens
to carry an ad id.

| rung | confidence | means |
| --- | --- | --- |
| `ad_id` | 0.98 | the CRM captured an ad id at lead creation |
| `phone_e164` | 0.92 | no CRM deal linked this booking; the guest's phone matched a lead |
| `utm_campaign` | 0.86 | only the campaign name connected them |

0.86 is the page's own floor; anything scoring lower is left unresolved rather than
counted. Unresolved bookings carry a stated reason and their **revenue is totalled** —
that is what makes an unmatched booking matter rather than look like a tidy-up task.

*Exit — met, for the metric half of this phase.* The fixtures resolve on two different
rungs, which is the whole argument for having a ladder: `B-1001` arrives through its CRM
deal and its lead's ad id, while **`B-1002` has no deal row at all** and is reachable only
by phone. Match rate is 2/2; on the deal link alone it would be 1/2. Exposed as
`match` on `/ingest/status` and as a warning in the notification panel when anything is
unresolved. 16 tests in `test/identity.test.js`.

**Stated limitation.** The `ad_id` rung records that the CRM captured an ad id; it does not
verify that id against the ad platform's own ad record. The id chain (ad → adset →
campaign) lives in the raw payloads and stage 2's mappers keep only names, dates and spend,
so canonical entities cannot see it. Verifying it means carrying those ids through
normalisation — a Phase 4 change, deliberately not smuggled in here.

**5.2 — Attribution as a workspace parameter · done** (2026-08-05). `lib/attribution.js`,
persisted to `var/workspace.json`, previewed in `views/app/attribution-preview.ejs`, applied
through `POST /workspace/attribution`.

Phase 2 wired the seven models as a per-screen URL toggle (`/attribution?model=last`). That
was right to build then and wrong to keep: the page specifies "a **workspace** attribution
model" applied on every revenue read, and a control living on one screen lets two screens
disagree about what a booking was worth. The credit table moved out of `data/attribution.js`
into the registry — that module now renders the model, it no longer owns it — and the route
threads `model` into **every** `repo.read`, including the shell. A screen with no
model-dependent content simply ignores it.

Three consequences the page asks for follow from making it a setting:

- **Preview before applying.** Selecting a model no longer changes anything; it shows what
  would change. Switching from Data driven to Last click moves ₹9.4L of credit to Direct
  and takes Meta's ROAS from 4.8x to 2.9x — the spread between models *is* the argument,
  and nobody should meet it after the fact. The preview bar states which model is **still**
  crediting revenue, because the screen behind it already shows the candidate's figures and
  that is exactly how someone comes away believing a change took effect when it has not.
- **Justification.** A change is a claim about how the business credits revenue, so it is
  recorded with a reason, and `custom` cannot be applied without one — the page's own words
  are "Your weights; requires justification".
- **History.** Every change keeps its from/to, timestamp, reason and the impact it had, so
  a number that moved can be explained by the decision that moved it. A corrupt or
  unreadable store resets to the default *and records that it did* rather than quietly
  looking like a choice someone made.

Applying is a `POST`, not a link: it changes what every revenue figure in the product means.

*A property worth recording.* **Attribution reapportions revenue; it does not create or
destroy it.** Every one of the seven models credits the same ₹52.3L — the July net revenue
the design states elsewhere — to within a 0.1 rounding artefact of its one-decimal figures.
That invariant is the sanity check on the whole table, and it is now a test. It also
corrected an assumption made while writing that test: the first version asserted the totals
*differed*, and the table proved otherwise.

*Exit — met, for the re-crediting half of this phase.* 26 tests in
`test/attribution.test.js`.

*What is not computable yet, stated plainly.* Multi-touch weighting needs a touchpoint
chain per booking. The fixtures carry two `lead_event` rows in total, so Shapley or
time-decay weighting over *ingested* touchpoints cannot be computed at this scale — with
one touchpoint every model credits it fully and they all agree. The mechanism is real; the
per-channel weights stay the design's reviewed figures until there is touchpoint data to
compute from.

*A flaw it made visible, since fixed.* Previewing a non-default model used to put the
Sankey's hardcoded ₹18.9L Meta node beside the table's re-credited ₹14.1L, on screen at the
same time. That was filed as blocked on the design export and turned out not to be — see
Phase 2, where binding the literal moved into the converter.

**5.3 — Restatement & report flagging · done** (2026-08-06). `lib/reports.js`, surfaced in
the notification panel, exposed at `POST /reports/send`, `GET /reports/dispatches` and
`…/:id`. 17 tests in `test/reports.test.js`.

This was blocked for several sessions on a real gap: nothing recorded a report as having
been *sent*, so the flagging rule had nothing to flag. The store is small — what was
unblocked it was 6.2, which already produces an evaluation record carrying values, inputs
and the definitions in force. A dispatch pins one of those.

The exit criterion is the sharpest sentence in the plan — *already-sent reports are flagged
on restatement rather than silently altered* — and **both halves are load-bearing**. A
report that quietly updates itself makes a liar of whoever quoted it in a meeting; one that
never updates leaves people acting on a figure since corrected. So the sent copy is
immutable **and** the drift is announced beside it. The values a dispatch carries are
*copied* out of the evaluation rather than referenced: a recipient's PDF does not change
because a store was replayed.

Three outcomes are reported separately, because they call for different responses:

| | means | response |
| --- | --- | --- |
| `dataMoved` | same definitions, different number | the source restated — reissue |
| `definitionMoved` | somebody changed what the metric means | the old report is not wrong, it answers a different question — explain |
| `unreproducible` | the metric is no longer in the registry | the report cannot be reproduced at all |

A dispatch records **only the metrics the report showed**, so a later restatement never
flags a figure the recipient never saw, and each is compared **at its own grain** — checking
a campaign report against workspace totals would invent a restatement that never happened.

*Exit — met, end to end.* "Owner weekly" was sent carrying ₹42,800 net revenue, 1 booking
and 1.4x ROAS. A late-arriving ₹18,000 booking was appended to the raw store; the dispatch
was immediately flagged stale with all three figures moved (₹42,800 → ₹60,800, 1 → 2,
1.4x → 2.0x), every one classified as a source restatement rather than a definition change
— **and the sent copy still read ₹42,800**. The notification panel raises it as critical,
since a recipient is holding a number the product no longer agrees with.

*What this is not.* Nothing is actually dispatched. There is no mail transport, no PDF
renderer and no scheduler — those are Phase 8. `send` records that a dispatch happened,
which is the fact 5.3 needed and nothing had.

---

## Phase 6 — Metric registry · closed

Implements stage 5, and is the heart of the product.

**Closed by decision on 2026-08-06**, with 6.1, 6.2, 6.3 and 6.5 complete and 6.4 at 43%
(since risen to 53% as Phase 8 bound three more surfaces to the registry).
The exit criterion below asks that *every* KPI in the UI resolve to a registry entry. That
was raised as unreachable twice and the phase was closed anyway, deliberately: the remaining
50 cards need systems nobody has connected, not more code. **This changes the plan's status,
not the coverage figure** — `/metrics/coverage` still reports 43% and still names every card
that does not resolve.

**Goal.** One definition per KPI, read by every dashboard, report and AI answer.

**Scope.** A registry where each metric carries all twelve fields the Analytics Engine
specifies: id/name, description, formula, sources, refresh, owner, dependencies,
benchmark, thresholds, favourability, format, ai_context. Formulas evaluate in dependency
order over other registry metrics — never raw SQL in the UI. Results are versioned with an
input snapshot so any past number reproduces exactly. Late-arriving data restates and
flags. The formula builder and custom metrics ride on this.

**Depends on.** Phase 5 — attribution is an input to profitability metrics.

**Exit criteria.** Every KPI in the UI resolves to a registry entry; none is hardcoded in
markup. A number from three months ago reproduces exactly. Changing a definition creates a
new version and leaves existing reports rendering on theirs.

### Sub-phases

| | Name | State |
| --- | --- | --- |
| 6.1 | Registry, formulas & dependency order | **done** |
| 6.2 | Versioned results with input snapshots | **done** |
| 6.3 | Definition versioning & restatement | **done** |
| 6.4 | Screens read the registry | **53%** — closed at the data ceiling |
| 6.5 | Dimensioned metrics | **done** |

**6.1 — Registry, formulas & dependency order · done** (2026-08-05). `lib/metrics/` —
`registry.js` (definitions), `formula.js` (evaluation), `index.js` (ordering, formatting,
bands). Exposed at `GET /metrics`, and `GET /metrics?id=roas.net` for one definition in
full. 29 tests in `test/metrics.test.js`.

Nine metrics: four **base** ones that read canonical entities directly (`ads.spend`,
`revenue.net`, `bookings.confirmed`, `leads.count`) and five **derived** ones that are
arithmetic over those (`roas.net`, `cost.per_booking`, `cost.per_lead`, `booking.value`,
`lead.conversion`). Base metrics are the only place the registry touches data, so any
number can be explained by walking down its dependencies to the systems at the bottom.

**All twelve fields are mandatory and enforced at load.** `assertMetric` refuses a
definition missing any of them, and the module throws on require rather than at first use —
a registry that accepts an incomplete definition is a registry two screens will eventually
disagree about. `benchmark` and `thresholds` may be `null`, but the key must be present:
absent and null are different claims, one an omission and the other a decision.

**Formulas are arithmetic over metric ids, and nothing else.** The page is explicit —
"never raw SQL in the UI" — so `formula.js` is a hand-written tokeniser and recursive-descent
parser with no `eval`, no `new Function`, and no path to a query. `SELECT * FROM bookings`
is refused three different ways depending on where it breaks. A formula referring to a
metric the registry does not define is an error, not an empty value.

Two rules in the evaluator matter more than they look:

- **Division by zero is `null`, not `Infinity`.** A ROAS with no spend is not infinitely
  good; it is unknown, and every threshold and format downstream must be able to tell the
  difference.
- **An unknown input makes the whole expression unknown.** Carrying a zero through instead
  would silently turn "we do not know" into "it is nothing" — which is the characteristic
  failure of a metric layer, since it produces a number that looks measured.

**Calculation order comes from the dependency graph**, by topological sort, not from the
order definitions happen to be written in — there is a test that reverses the registry and
checks every dependency still evaluates first. A cycle is reported with the ring that
closes it. A definition whose declared `dependencies` disagree with its own formula is
refused, because order comes from one and impact analysis from the other.

`favourability` earns its place immediately: `cost.per_lead` and `cost.per_booking` are
`lower`, so the same band logic that paints a 5x ROAS green paints a ₹200 CPL green too.
The page's own example — "a falling CPL must render green" — is a test.

*Note on scale.* Evaluated against the fixtures, `cost.per_lead` reads ₹7,738 against a
₹350 target, because the CRM recorded 4 leads while the ad platforms reported 92. That is
arithmetic doing its job on thin data, and it is also a real definitional question the
registry now makes explicit: `leads.count` counts **CRM** enquiries, which is what its
description says.

**6.2 — Versioned results with input snapshots · done** (2026-08-06).
`lib/metrics/versions.js`, exposed at `POST /metrics/snapshot`,
`GET /metrics/snapshots`, `…/:id` and `…/:id/reproduce`. 19 tests in
`test/versions.test.js`.

The exit criterion — *a number from three months ago reproduces exactly* — can only be met
honestly by keeping what the number was computed **from**. A stored figure with no inputs is
a claim; a stored figure with its inputs is a receipt. So every record carries three things,
and the second is the one usually forgotten:

- **inputs** — the canonical entities the evaluation read
- **registry fingerprint** — every definition in force at the time
- **values** — what came out

Without the fingerprint a figure that has moved is ambiguous: the data may have been
restated, or somebody may have edited the formula. Those need different responses, and
`reproduce` reports them separately — `reproduced` for whether the same inputs still give
the same answers, `registryChanged` and `definitionDrift` for whether the definitions moved
underneath. **The same inputs giving a different answer under unchanged definitions is a
bug; the same inputs giving a different answer after a definition changed is a restatement.**
That distinction is what 6.3 will build on.

The fingerprint covers formula, dependencies, thresholds, benchmark, favourability, format,
refresh and owner — but deliberately **not** `description` or `aiContext`. A moved threshold
changes how a number reads and counts as a redefinition; rewording a sentence must not
register as a restatement.

Reproduction re-runs the evaluator over the stored inputs rather than echoing the stored
values back — there is a test that corrupts a stored value and checks the mismatch is
caught, because an implementation that simply read the values back would "reproduce"
anything. This works only because `evaluate` is a pure function of a snapshot with no clock;
a test asserts that too.

*Exit — met.* A recorded evaluation reproduces exactly, at the workspace grain and at a
scoped one. Editing a threshold leaves the values reproducing while flagging
`roas.net` as redefined.

*On storage.* Whole entity sets are written inline, which is right at fixture scale and
wrong at production scale — there the record would reference the append-only raw store by
window. The record shape does not change; only where `inputs` points does.

**6.3 — Definition versioning & restatement · done** (2026-08-06).
`lib/metrics/definition-log.js`, reconciled at boot, exposed at `GET /metrics/definitions`.
13 tests in `test/definition-log.test.js`.

All three requirements are met:

- *Existing reports keep rendering on theirs.* A dispatch freezes the definitions in force
  at send time, so an edited definition never rewrites a report already out. (5.3)
- *Late-arriving data restates and flags.* Demonstrated end to end in 5.3.
- *Changing a definition creates a new version.* Each metric now carries its own version,
  advancing only when **it** changes — editing the ROAS thresholds does not version the
  other twenty-five.

Definitions live in code, so the log works by **reconciliation** rather than by being told:
it compares what is in force against what was last recorded and mints versions for what
moved, recording *which fields* moved. A moved threshold and a rewritten formula are
different events and the history says which. Rewording `description` or `aiContext` mints
nothing, since those sit outside the fingerprint.

Two decisions worth recording. **v1 is `added`, not an edit** — otherwise the first boot
reads as though somebody rewrote the whole registry. And an **edit plus its reversal leaves
the version at v3, not back at v1**: versions count edits, not distinct states, because a
report sent under v2 went out against a definition that really was different at the time.

**On authorship.** The app cannot see who edited a source file, and a governance record
naming the wrong person is worse than one naming nobody — so `author` is recorded when a
caller supplies it and renders as `unattributed` otherwise. Wiring it to a real identity
belongs to Phase 9, where users start existing.

**6.4 — Screens read the registry · mechanism done, coverage at 8%** (2026-08-05).
`lib/metrics/resolve.js`, applied to every screen read in `server.js`, with the criterion
itself checkable at `GET /metrics/coverage`. 17 tests in `test/resolve.test.js`.

A KPI card declares which metric it **is** — `metric: 'roas.net'` — rather than only
carrying a number and a tooltip. Two things follow, and the first is worth more:

- **The definition travels with the number, under every driver.** Owner, formula, sources,
  refresh, favourability, thresholds and the AI's licence to talk about it are attached to
  every card that names a metric. That is what stops two screens disagreeing about what
  "Net ROAS" means, and it holds even when the value itself is authored.
- **Where the value comes from is a separate question.** Under `ingested` the registry's
  computed figure replaces the card's; under `static` the authored figure stays. Dropping a
  fixture-scale number into an authored dashboard would produce a screen that is neither
  one thing nor the other. Each card records which it got, in `valueSource`.

Verified end to end across both drivers. The dashboard's mini KPIs read
₹10.9L / ₹427 / ₹3,480 / ₹8,940 under `static` and ₹30,951 / ₹7,738 / ₹30,951 / ₹14,267
under `ingested` — the last being ADR, correctly ₹42,800 across a three-night stay. An
authored delta is dropped when the value is replaced, because "+12.4%" beside a registry
figure attaches a change to a number that never changed that way; period comparison arrives
with 6.2.

Adding this surfaced a mis-mapping worth recording: ADR was first pointed at
`booking.value`. **Average booking value is not average daily rate** — a three-night stay is
one booking and three nights — so `stay.room_nights` and `rate.adr` were added rather than
letting a card name a metric that meant something else.

**A time dimension was added** (`lib/metrics/period.js`), which was the one lever that could
raise coverage without new data sources. Like a grain, a period narrows the **entities**, so
`leads.count` over the last 24 hours is the same definition, not a new metric — and derived
metrics follow their inputs into the window for free. 18 tests in `test/period.test.js`.

Which date a record belongs to is declared per collection rather than assumed, because it is
a decision: **a booking belongs to the night stayed (`checkIn`), not the day it was booked.**
Revenue has to sit beside occupancy and RevPAR, which come from inventory rows that are per
night by construction; dating a booking by when it was made would put July revenue against
August room nights and quietly break every rate metric. A June booking for an August stay
therefore counts in August — correct for a revenue manager, surprising for anyone expecting
a sales ledger.

The reference instant is **passed in, never read from the clock inside the metric layer** —
6.2's reproducibility rests on evaluation being a pure function of its inputs, and a metric
that consulted `Date.now()` could not be replayed.

That closed three cards: "New leads today" (`leads.count` over 24h), "Lost this month"
(`leads.lost` over the month), and "Untouched > 2h" — the last needing a new metric,
`leads.unanswered`, since "older than two hours" is the period and "nobody replied" is the
measure.

*Exit — not met, and it cannot be met with the sources this product has.* **47 of 88 KPI
cards resolve (53%)**, up from 7 (8%) when the mechanism landed. Dashboard 11/12,
Reports 9/10, Marketing 8/10, CRM 7/10, Campaigns 12/18, and Website, AI and Sales at 0.
`/metrics/coverage` names every unresolved card.

*(The figure was 43% when this phase was closed; Phase 8 raised it to 53% by binding the
scorecard, builder canvas and presentation slide to the registry. Nothing was reopened —
the closure was about the plan waiting, not about the number stopping.)*

**The remaining 41 are not missing definitions — they are missing data:**

| reason | cards | example |
| --- | --- | --- |
| no connected system reports it | 15 | Sessions, Users, Bounce rate, Frequency, MER, every call metric |
| authored AI narrative, belongs to Phase 7 | 16 | the AI screen's summary and forecast tiles |
| needs an entity canonical does not build | 10 | Pipeline value (deals), Qualified (lead stage), folio gross/cancelled/commission lines, follow-up tasks, stage velocity |

Raising this further needs a **new source connected**, not more code. Every remaining card
was left unresolved with its reason written beside it in the data module, and none was given
a fabricated formula to improve the figure.

Widening it required going back to Phase 4. `inventory_day` and `lead_event` were being
normalised and never became canonical entities, so occupancy, RevPAR and lead response had
nothing to be defined against. Both are now built, and the registry grew from 9 metrics to
24 — adding delivery-side measures (`ads.impressions`, `ads.clicks`, `ads.ctr`, `ads.cpm`,
`ads.reported_leads`), inventory (`inventory.available`, `inventory.sold`, `occupancy.rate`,
`rate.revpar`), booking status (`bookings.all`, `bookings.cancelled`, `cancellation.rate`)
and `lead.response_minutes`.

Two corroborations worth recording: occupancy computes to **77%** against the design's
stated 78%, and lead response to **38 minutes** against its stated 44-minute median. Neither
figure was fitted — both fell out of the fixtures.

A normalisation bug surfaced doing it. `lead.response_minutes` read zero events on its first
run because stage 2 was passing the event type through `n.text`, which title-cases —
turning `first_response` into `First_response`, so every comparison missed. **An event type
is a machine token, not prose**; the mapper now passes it through raw like the ids beside
it, and the metric compares case-insensitively so a future normalisation change cannot break
it back silently.

No card has been given a fabricated formula to improve the percentage, and none will be.
40% is what this product's five sources can honestly answer.

---

**6.5 — Dimensioned metrics · done** (2026-08-06). `lib/metrics/scope.js`, threaded through
`evaluate`/`report`, exposed at `GET /metrics?at=campaign:<key>`. 20 tests in
`test/scope.test.js`.

6.4's ceiling was that Campaign Analytics shows eighteen cards about *one campaign* while
every registry metric is a workspace-wide total. The fix is **not** more definitions — one
definition per KPI is the registry's whole promise. Instead the **entities** narrow, and
because base metrics read entities while derived metrics are arithmetic over base metrics,
scoping the entity set scopes the entire graph for free: a campaign's ROAS is its own
revenue over its own spend without `roas.net` knowing campaigns exist. There is a test for
exactly that.

Three dimensions — `campaign`, `channel`, `property` — and the hard part is not filtering.
**Not every metric is meaningful at every grain.** Occupancy per campaign is nonsense: a
property's rooms are not attributable to the ad that sold one of them. Ad spend per property
is nonsense the same way. So a metric whose collections cannot all be narrowed by the
requested dimension is returned **not applicable** — not zero, and not the workspace figure
quietly reused, which is the error nobody would catch. A metric spanning two collections is
answerable only where *both* can be narrowed, so ROAS by property is refused rather than
computed from one narrowed and one workspace-wide input.

Which collections a metric reads is **derived**, not declared twice: each base metric's
`source` is run once against a recording proxy, so a metric declares its reads simply by
using them. That would miss a collection read inside a conditional, so the test file asserts
the derived map against an explicit one — the test is what makes the trick safe rather than
merely clever.

*A join bug this surfaced.* Property scoping read zero available rooms, because
`inventoryDays` carried the property **id** (`P-MUN`) while bookings carried the **name**
(`Munnar Hillside`) — so occupancy for a property silently computed against nothing.
Canonical now resolves one to the other from the booking payloads, keeping the id alongside
for tracing. A property appearing only in inventory has no name to resolve and is not
offered as a grain at all, rather than being listed as a raw id beside real names.

*Exit — met.* The campaign drill-down now renders ₹13,821 spend, 2,90,100 impressions,
2 leads and 3.1x ROAS under `ingested` — its own figures, against workspace totals of
₹30,951, 5,46,700 and 4. Cards whose metric is not a question at that grain say so instead
of showing a number.

---

## Phase 7 — AI reasoning layer

Implements stage 7.

**Goal.** Explanations that match the dashboards, because they read the same registry.

**Scope.** The AI reads the registry, never the raw tables. Every explanation follows the
six-step contract: state the change, decompose the drivers with quantified shares, name
related metrics, distinguish real efficiency from a mix shift, recommend with an expected
value, declare confidence and sources. Unquantifiable drivers are declared, not estimated.
Confidence below 60% suppresses the recommendation and shows the gap.

**Depends on.** Phase 6.

**Exit criteria.** Every claim resolves to a registry metric and a time window. No
unsourced assertion. The suppression rule is enforced, not advisory.

**Done** (2026-08-06). `lib/ai/explain.js` and `lib/ai/reasoner.js`, exposed at
`GET /metrics/:id/explain?over=7d&against=30d`. 25 tests in `test/explain.test.js`.

**There is no language model here, and that is the design rather than a shortfall.** The
page's requirement is that the AI *"reads the same registry — never the raw tables — so
explanations match the dashboards"*. An explanation that queried entities directly could
contradict the number on screen, and a product whose narrative disagrees with its own
dashboard is worse than one with no narrative. So every claim is derived from a registry
evaluation and carries the metric and window it came from.

`lib/ai/reasoner.js` holds the seam, arranged exactly as `lib/ingest/transport.js` is and
for the same reason: `registry` answers today, `model` throws with its reason — there is no
API key, no reviewed prompt, and no evaluation that generated prose would satisfy the
six-step contract. **A model-backed reasoner would have to produce the same six steps, carry
the same provenance, and pass the same `assertSourced` check. It gets to be more fluent; it
does not get to be less accountable.**

The six steps, and what makes each honest:

1. **State the change** — both windows named. "Revenue is up 12%" without saying up from
   when is the commonest unsourced assertion in analytics. Direction is read through
   `favourability`, so a rising cost per lead is *worse*, not *up*.
2. **Decompose the drivers** — sequential decomposition for a ratio: hold the denominator,
   move the numerator, then move the denominator. The two contributions sum to the whole
   change exactly, which is what makes the shares quantified rather than indicative.
3. **Name related metrics** — straight off the dependency graph, not a judgement about what
   is "related".
4. **Cause, not mix** — for a ratio, whether the measured quantity moved or the base did.
5. **Recommend with an expected value** — names the lever and the assumption behind it.
6. **Declare confidence and sources** — a percentage built from observations the product
   already makes (stage 3 match rate, normalisation problems, sample size, unknown inputs),
   never a feeling about the data.

Two rules are enforced rather than intended. **Unquantifiable drivers are declared, not
estimated** — a base metric has no decomposition and says so; an unknown or zero input
blocks the split rather than producing a number. And **confidence below 60% suppresses the
recommendation** inside the layer, not at the call site, showing the gap that would have to
close first.

*Exit — met.* `assertSourced` runs on every explanation and the reasoner **withholds** one
it cannot source rather than shipping it with a warning.

*A bug caught by running it.* The first version reported "Net ROAS did not move. No action
indicated." for a metric that could not be computed in *either* window — a confident
sentence about nothing, because `null === null` read as unchanged. **Unknown is not
unchanged**; it now suppresses the recommendation and says which it is. There is a test
named after the mistake.

---

## Phase 8 — Alerts, reports & scheduling

**Goal.** The product acts without being opened.

**Scope.** Metric-driven alert rules evaluating on the same cadence as the metric they
watch, each carrying a false-positive count so noisy thresholds stay visible. Report
scheduling and sharing. The dashboard builder, scorecard and presentation mode become
functional rather than static.

**Depends on.** Phase 6, and Phase 7 for the AI-suggested thresholds.

**Exit criteria.** A rule fires end-to-end to its configured channel. Every rule reports
its 90-day fire count and false-positive rate.

**Both exit criteria met** (2026-08-06). `lib/rules/` — `index.js` (the rules and their
evaluation), `channels.js` (delivery), `firelog.js` (fire history and false positives).
Exposed at `GET /rules`, `POST /rules/evaluate`, `GET /rules/fires` and
`POST /rules/fires/:id/judge`. 27 tests in `test/rules.test.js`.

**The eight rules are the Analytics Engine page's own alert table** — names, conditions,
severities and recipients verbatim. Each watches a **registry metric**, which is what makes
them metric-driven in the sense the scope asks: a rule cannot reference a number the
dashboards do not also show, and it evaluates on the cadence of the metric it watches rather
than on a schedule of its own.

**Three of the eight cannot be evaluated, and say so rather than sitting quietly:**

| rule | why not |
| --- | --- |
| Occupancy below forecast | no forecast metric — forecasting is a model output the registry does not produce |
| Creative fatigue | no fatigue score; creatives are ingested but never scored |
| Booking slowdown | "pace" compares against a plan, and no target or plan series is ingested |

`evaluate` returns **fired, held, or unevaluable** — three states, not two. A rule nobody can
compute is not a rule whose condition was not met, and a panel showing both as quiet would be
reassuring about the wrong thing. The same distinction appears in the reasoning layer and the
projections: unknown is never "fine".

*Exit — a rule fires end-to-end.* Verified: **High cancellation rate** fires against the
fixtures (1 of 2 bookings cancelled, 50% against a 3% ceiling), delivers, and is recorded.

**On channels.** The design configures email, Slack and WhatsApp; none can be reached — no
SMTP host, no workspace token, no Business API account. Each reports exactly that and does
not stop the others. But a rule that fired where nobody could see it would satisfy the letter
of "end-to-end" and miss the point, so **`log` is attempted whatever the rule configured**,
and fires from the last day also surface in the notification panel — the one channel that
always works. Whether the condition was met and whether anybody was told are kept as separate
facts on the fire.

*Exit — every rule reports its counts.* `GET /rules` carries a 90-day fire count and
false-positive rate per rule. **A false positive is never inferred** — whether a fire was
worth having is a judgement somebody makes afterwards, so it is recorded when a human says
so, and a rule with no reviewed fires reports its rate as **unknown rather than 0%**.
Claiming zero false positives for an unreviewed rule would flatter exactly the thresholds
that need watching. Judging annotates the log rather than rewriting the fire, and somebody
may change their mind.

**Report scheduling · done.** `lib/schedules.js` holds the design's five schedules with a
structured cadence beside each human string — "Mondays 08:00 IST" is what a person reads and
`{ every: 'week', weekday: 1, hour: 8 }` is what a scheduler can act on, and parsing the
prose at runtime would put a fragile regex between the design and whether a report goes out.

Every cadence is **IST**, stated rather than assumed: a scheduler silently running on the
server's timezone would send the 07:30 digest at whatever 07:30 meant to the machine.
**Due-ness is computed from the last dispatch, not from a timer** — the same reasoning as the
4.5 sync runner, so a process that was down over Monday morning sends Monday's report when it
returns instead of skipping it. The paused schedule stays paused; a product that ran a
schedule because it could would be overriding a person.

`GET /schedules`, `POST /schedules/run`. Verified against the calendar: Owner weekly lands on
Monday 10 August 08:00 IST, Marketing performance on Friday 7 August 17:00 IST, the board
pack on 31 August, and the paused one has no next run at all.

`Dispatches.update()` was added for this and is deliberately **not** a general update — it
restores `carried` and `definitions` from the stored copy whatever the caller passes, because
those are what the recipient saw.

**Builder, scorecard and presentation · done, within what the design defines.** All three
now read the registry rather than carrying their own copies of the same numbers: the
scorecard's six tiles, the builder canvas's four KPI widgets and the presentation slide's
three headline figures all name their metric. Under `ingested` every one of them renders the
derived figure. The canvas's chart and table widgets carry no metric — the registry defines
numbers, not series.

`resolve` was widened for this: a collection now resolves if **any** row names a metric,
rather than only uniformly KPI-shaped ones, because the builder canvas mixes KPI tiles with
charts. `coverage` still counts only KPI-shaped rows, so the Phase 6 figure means what it
meant before.

Presentation's three controls — Fullscreen, Dark room, TV mode — are wired in
`public/assets/app-ui.js`. The design draws them as plain spans with no `onClick`, so there
is no `data-action` to preserve and they are found by their icons; the generated markup is
untouched.

**What is deliberately not built: slide stepping.** The design draws **one** slide and labels
it "Slide 2 of 6". The other five do not exist as markup, so stepping through them would mean
inventing five slides. The label is design text and stays as drawn.

---

## Phase 9 — Tenancy, auth & permissions

**Goal.** More than one workspace, safely.

**Scope.** The workspace switcher in the chrome implies multi-tenancy. Roles are already
named across the design — Owner, Marketing Director, Revenue Manager, GM, Reservations
Manager, Sales Manager, Analyst. Permission-filtered serving (pipeline stage 6). Gated
actions: attribution changes are Owner and Marketing Director only; custom metric edits
are Owner plus Analyst. Audit log for every gated change.

**Depends on.** Phase 3 minimum; realistically alongside Phase 6.

**Note.** Consider pulling forward if a second workspace is ever likely — retrofitting
tenancy is materially harder than building with it.

**Exit criteria.** No cross-workspace data access. Every gated action is enforced
server-side and audited.

**Both met** (2026-08-06). `lib/auth/` — `identity.js` (users, roles, workspaces),
`permissions.js` (the gates), `sessions.js` (signed cookies), `audit.js` (the log),
`index.js` (the middleware). 26 tests in `test/auth.test.js`.

*Exit — no cross-workspace data access.* **The raw store is partitioned**:
`var/raw/<workspace>/`. Isolation is a property of *where the data is*, not of a filter
applied on the way out, so a tenant with no ingested data gets an empty store rather than
somebody else's — there is nothing else in its directory. Verified with a second seeded
workspace: the Parakkat owner sees ₹42,800 / 1 booking / 4 leads / 100% match, the Kestrel
owner sees ₹0 / 0 / 0 / no match rate, and neither sees the other's audit trail.

**`req.workspace` comes from the session, never from the request.** A `?workspace=`
parameter that is *checked* against the session is still a parameter somebody will one day
forget to check; taking it only from the session leaves nothing to forget. Confirmed by
asking as Kestrel with `?workspace=parakkat` — the parameter is simply ignored.

*Exit — gated actions enforced server-side and audited.* The design's two named gates are
implemented exactly as written: *attribution changes are Owner and Marketing Director only*
and *custom metric edits are Owner plus Analyst*. Six more follow the roles the design
already names. **Deny by default**, including for an action that does not exist — a table
returning "allowed" for an unknown string would fail open the first time somebody typo'd a
gate.

**Refusals are audited, not only successes.** A success-only log answers "what changed" but
never "who tried", and a Sales Manager repeatedly attempting to change the attribution model
is exactly the fact it would discard. The audit is scoped per workspace and **defaults to
returning nothing** rather than everything — a reader defaulting to "all tenants" is one
forgotten argument away from a leak.

Sessions are signed cookies with server-side state; **the role is never in the cookie**,
because trusting the browser about permissions would defeat server-side enforcement.
`httpOnly`, `SameSite=Lax`, and `Secure` only once there is TLS to be secure over.
`LEADINTEL_SECRET` signs them; without it a per-process secret is generated and a warning
printed, so sessions last until restart and no further — a hardcoded default would be worse
than either.

**On the accounts.** Six seeded users across two workspaces, all sharing one password that
is printed on the sign-in page. They are fixtures, not people: no registration, no reset, no
email. The password is stated in the open because a fixture credential that looked secret
would be the worst of both worlds. It is nonetheless scrypt-hashed and compared in constant
time — the first real account will arrive through this same door.

**Deferrals, stated rather than discovered later:**

- **Sessions live in memory.** Honest for one process, wrong for several — two instances
  would not share logins. Moves to a shared store in Phase 10, alongside the sync loop,
  which has the same shape of problem.
- **The webhook route is behind the session gate**, which is safe and also means no real
  source could call it: a webhook needs a signature from the sending system, not a browser
  session. Not built.
- **`LEADINTEL_AUTH=off`** serves as Owner with no sign-in, for working on the screens. It
  throws on startup if `NODE_ENV=production`.
- **The sign-in page is not the design's.** `LeadIntel Auth & Onboarding.dc.html` exists in
  the design project and has never been converted; this one is deliberately plain so that
  little is thrown away when it is.

---

## Phase 10 — Hardening & deploy

**Goal.** Runnable by someone other than its author.

**Scope.** Performance against the design's own budget — under 200 ms p95 for served
queries, pre-aggregated cubes for common cuts and live query otherwise. Error handling,
observability, sync-lag monitoring (there is already a "Connector down" alert specified).
Accessibility pass: the converted markup is div-heavy with inline styles and no semantic
roles or keyboard affordances. Deploy, backups, restore drill.

**Depends on.** Everything.

**Exit criteria.** p95 within budget under realistic load. A cold restore succeeds.

**Both met** (2026-08-07). `lib/http/hardening.js`, `lib/http/observability.js`,
`tools/backup.js`, plus a keyboard pass in `public/assets/app-ui.js`. 21 tests in
`test/hardening.test.js`.

*Exit — p95 within budget.* **1,344 requests from 8 concurrent signed-in users across all
13 screens: worst p95 is 62 ms against the design's 200 ms budget**, at 47 requests/second.
Every route passes. Measured, not asserted: `/health` reports p50/p95/p99/max per route and
whether each is inside the budget.

Percentiles are computed from kept samples rather than a running average, because **a mean
hides exactly the tail a budget is about** — a hundred 5 ms responses and one 3-second one
average to 35 ms and would pass a 200 ms budget they plainly fail. Nearest-rank, so every
figure reported is a duration that actually happened rather than an interpolated one. Sample
counts are stated beside the percentiles: a p95 over the last thousand requests is a
different claim from one over all of them.

*Exit — a cold restore succeeds.* `node tools/backup.js drill` takes a backup, **deletes
`var/` outright**, restores, and rebuilds the canonical entities from the restored store to
check they match. A restore tested without first destroying anything tests nothing. Verified:
17 files, no checksum mismatches, and 6 campaign-days / 4 leads / 2 bookings / ₹42,800
identical either side of the wipe.

**Hardening.** CSP, `nosniff`, `DENY` framing, referrer and permissions policy, HSTS only
when `LEADINTEL_TLS=on` — teaching a browser to refuse plain HTTP on an origin that only
serves it is how a local install becomes unreachable. The CSP is worth reading: `style-src`
must allow `'unsafe-inline'` because the converted markup carries its styling inline, while
`script-src` does not and does not get it. Rate limiting on the sign-in route, which is the
door — everything else already needs a session.

**Production refuses to start misconfigured** rather than warning: `LEADINTEL_AUTH=off`, a
missing `LEADINTEL_SECRET`, or TLS not on are each fatal under `NODE_ENV=production`. A
warning in a startup log is read once, by the person who already knew.

**Graceful shutdown** on SIGTERM/SIGINT: stop the sync loop, let in-flight requests finish,
exit — with a 10-second cap so one stuck request cannot hold the process.

**Accessibility.** The converter preserves the design's click targets as `data-action` on
`div`s and `span`s, which are not focusable and do not fire on Enter — so the entire
sidebar, every tab and every drill-through row was unreachable without a mouse. They are
promoted at runtime rather than in the markup, for the usual reason: `views/screens/` is
generated, so a converter re-run cannot undo this and it covers elements the design has not
drawn yet. Verified in a browser: **25 of 25 clickable elements focusable and accessibly
named**, a skip link as the first tab stop, and Enter activating a sidebar item. Space is
handled too, with its default prevented — a focused control that scrolls the page instead of
activating is worse than one that does nothing.

*A bug the tests caught.* Route names for timing collapsed ids with a hex pattern, which
matched **none** of this app's ids because every one carries a `T` and a `Z` from its
timestamp. Percentiles were being computed per-dispatch rather than per-route — one sample
each, which is not a percentile. Matching on shape (a long segment containing a digit) fixes
it, with a test that real route names are not collapsed by the same rule.

**What is not done, and needs a decision rather than code:**

- **No deploy target.** Nothing is hosted. The app runs from a checkout with `npm start`.
- **`var/` is the database.** Every store is file-backed and process-local. That is honest
  for one node and wrong for several.
- **Sessions and the rate limiter are in memory**, as is the sync loop's schedule — all
  three want the same shared backend the day a second instance exists.
- **No TLS**, so `Secure` on the session cookie is off; the flag exists and is wired to
  `LEADINTEL_TLS`.
- **No pre-aggregated cubes.** The scope mentions them for common cuts; at 62 ms p95 they
  would be optimising something that is not slow.

---

## Notes on sequencing

- **Phases 1–3 are the honest prerequisites.** Skipping to a backend before the shapes are
  validated by real content means building an API against a guess.
- **Phases 4–7 are the actual product.** Everything before is scaffolding and everything
  after is delivery. This is where the estimate lives, and where it will be wrong.
- **Phase 9 is the one to reconsider early.** It is placed late because nothing depends on
  it, not because it is easy.
- The Analytics Engine page is a specification, not decoration. Where this plan and that
  page disagree, the page wins — it is the reviewed artefact.
