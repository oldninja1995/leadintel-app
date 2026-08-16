/* The metric registry — one definition per KPI.
 *
 * Sub-phase 6.1, implementing stage 5. The page calls this the heart of the
 * product and gives it a schema of twelve fields; every definition below
 * carries all twelve, and `assertMetric` refuses one that does not. That is
 * the whole value of a registry: a metric whose owner or favourability is
 * "obvious" is a metric two screens will eventually disagree about.
 *
 *   id · name        stable slug plus display label used everywhere
 *   description      one plain sentence a GM would understand
 *   formula          expression over other registry metrics — never raw SQL
 *   sources[]        which systems feed it; drives the CRM/ADS/BLND badge
 *   refresh          realtime · 5min · 15min · hourly · nightly
 *   owner            the role accountable for the definition, not the number
 *   dependencies[]   upstream metrics — calculation order and impact analysis
 *   benchmark        internal target and, where available, a category figure
 *   thresholds       good / warning / critical bands driving colour and alerts
 *   favourability    whether up is good — a falling CPL must render green
 *   format           currency · percent · ratio · duration · count
 *   aiContext        what the AI may assert about drivers and caveats
 *
 * **Base metrics** carry a `source` function instead of a formula: they read
 * canonical entities directly and are the only place the registry touches
 * data. Everything else is arithmetic over other metrics, so a number can
 * always be explained by walking down its dependencies to the systems at the
 * bottom.
 *
 * Money is in **paise** throughout, as canonical entities carry it. Formatting
 * divides; arithmetic does not. See lib/repository/projections.js for the bug
 * that rule exists to prevent.
 */

const { references, compile } = require('./formula');
/* The channel rules — which statuses count as production, and the sum that
   answers null rather than 0 when nothing reported. Shared with the OTA screen
   rather than restated here: a metric and a table that classified a
   cancellation differently would disagree on the same page. */
const ota = require('../ota');

const REFRESH = ['realtime', '5min', '15min', 'hourly', 'nightly'];
const FAVOURABILITY = ['higher', 'lower', 'neutral'];
const FORMATS = ['currency', 'percent', 'ratio', 'duration', 'count'];

const sum = (rows, field) => rows.reduce((t, r) => t + (r[field] || 0), 0);

/* Which CRM status words mean what, in one place.
 *
 * These are workspace-defined labels with no type behind them — unlike won and
 * lost, which the lead-stage pipeline classifies for us — so the vocabulary has
 * to be matched rather than looked up. Both patterns fail *towards understating*
 * on purpose: an unrecognised status is not interested, and an unrecognised
 * booking status is not cancelled, so a rename shows up as a figure that looks
 * too low rather than as revenue nobody is going to receive.
 *
 * `qualif|quoted|booked` are in there because the first version was written
 * against one workspace's vocabulary — Interested, Hot, Won/Converted — and
 * missed the most ordinary word a CRM uses for this. Anything added here should
 * be a word that means the lead *engaged*, never one that means it was merely
 * touched: "contacted" and "ringing no answer" are work done to a lead, not
 * interest shown by one, and belong to UNTOUCHED's question instead. */
const INTERESTED = /interest|hot|warm|won|convert|qualif|quoted|booked/i;
const CANCELLED = /cancel/i;

/* A lead nobody has touched yet.
 *
 * "Response rate" properly means the share of leads someone actually replied
 * to, and that is an *event* — which TeleCRM cannot serve, because actions are
 * only readable one lead at a time (see the connector). Until the webhook is
 * delivering them, the lead's own status is the signal there is: a lead sitting
 * at Fresh has not been worked, and every other status in this workspace
 * records something a human did to it, "Ringing no answer" included — a call
 * that went unanswered is still a response.
 *
 * So this measures *worked*, not *replied to*, and the two diverge for a lead
 * somebody phoned without moving the status. It is stated on the metric rather
 * than smoothed over. */
const UNTOUCHED = /^\s*(fresh|new|open|unassigned|uncontacted)\s*$/i;

/* The channels that cost money. `other` and an untagged null are neither paid
   nor provably organic, so they are outside every paid figure — a floor is a
   defensible answer where a guess is not. */
const PAID_CHANNEL = new Set(['meta', 'google']);
const value = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/* NC — a New Customer. Somebody who had not enquired before.
 *
 * The whole definition is a comparison against history, which is why it cannot
 * be read off a lead's own fields: "first time" is a statement about every
 * OTHER enquiry, and a metric only ever sees the window it was handed. So
 * canonical.js stamps `repeat` on each lead against the entire store, with a
 * 365-day horizon, and this reads that stamp. See lib/ingest/canonical.js for
 * how one person is recognised across three spellings of a phone number.
 *
 * `repeat === false` rather than `!repeat`, deliberately. An unstamped lead —
 * one built by an older path, or a fixture written by hand — has `undefined`
 * there, and `!undefined` would silently call it new. Every unstamped lead
 * would then be a new customer and the figure would read near 100% with nothing
 * to show it was measuring the absence of a field.
 *
 * **THE HONEST LIMIT, and it is not small: this can only be as true as the
 * history behind it.** A guest who enquired last October looks new today if the
 * store starts in July. So the figure OVERSTATES new customers, by exactly the
 * repeat business that predates the store, and it converges on the truth as the
 * backfill walks back. Stated on both metrics and on the dashboard, because a
 * "new customer rate" that is silently measuring "how far back our data goes"
 * is the kind of number that gets taken to a board meeting. */
const isNewCustomer = (lead) => lead.repeat === false;

/* RC — a returning customer. The complement, and NOT one minus the other.
 *
 * A person can be both inside one window: they enquire for the first time on
 * the 3rd and again on the 20th, so they hold a new lead and a repeat lead in
 * the same thirty days. NC% and RC% therefore do not sum to 100 and must never
 * be presented as a split of one bar. Two questions about the same people —
 * "how many were reached for the first time" and "how many came back" — and
 * somebody can answer yes to both. */
const isReturningCustomer = (lead) => lead.repeat === true;

/* Ad-sourced only, by construction rather than by the topbar.
 *
 * These figures answer "of the demand we paid for, how much of it was somebody
 * new" — a question about what the advertising is reaching. An untagged lead is
 * not evidence about an ad, so it is outside the count AND outside the base;
 * new walk-ins are a real number and a different one. The channel chip still
 * narrows this further, so Meta alone is a selection rather than another
 * metric. */
const isAdLead = (lead) => PAID_CHANNEL.has(lead.channel);

/* Distinct people, not enquiries. `customer` is stamped in canonical.js against
   the whole store — a metric cannot compute it, because it only ever sees the
   selected window and the earlier enquiries are outside it. A lead with no key
   would collapse every anonymous lead into one customer, so it falls back to
   its own id and counts once. */
const keyOf = (lead) => lead.customer || `lead:${lead.id}`;
const customers = (leads) => new Set(leads.map(keyOf)).size;

/* ── the metrics ────────────────────────────────────────────────────────── */

const METRICS = [
  {
    id: 'ads.spend',
    name: 'Ad spend',
    description: 'What the ad platforms report spending in the period, across every campaign.',
    source: (e) => sum(e.campaignDays, 'spend'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Delivery-side figure from Meta and Google. May restate for up to 72 hours as the platforms finalise. Never describe it as revenue-affecting on its own.',
  },
  /* ── the CRM funnel ─────────────────────────────────────────────────────
   *
   * Enquiry → interested → won, measured from the CRM's own lead statuses,
   * because no other connected system knows any of it. Every one of these
   * narrows by the topbar like the rest, so "for Meta Ads" is a selection
   * rather than five more definitions.
   *
   * **What counts as "interested" is a judgement and is written down here
   * rather than buried.** It is matched on the status word — interested, hot,
   * warm, or anything already won — because these are workspace-defined labels
   * with no type behind them, unlike won/lost which the lead-stage pipeline
   * classifies for us. A status this does not recognise is *not* interested,
   * so the figure understates rather than flatters. Rename a stage in TeleCRM
   * and this needs editing; that is the cost of a vocabulary the API does not
   * type.
   */
  {
    id: 'leads.interested',
    name: 'Interested leads',
    description: 'Leads the CRM has moved past first contact — interested, hot, or already won.',
    source: (e) => e.leads.filter((l) => INTERESTED.test(String(l.stage || ''))).length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Derived from CRM status words, not from a typed field. Say so before drawing a conclusion about lead quality from it.',
  },
  {
    id: 'leads.responded',
    name: 'Leads worked',
    description: 'Leads the CRM has moved off its untouched status — someone has acted on them.',
    source: (e) => e.leads.filter((l) => l.stage && !UNTOUCHED.test(String(l.stage))).length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A lead with no status at all is not counted — absence of a stage is not evidence of neglect, it is absence of evidence.',
  },
  {
    id: 'leads.response_rate',
    name: 'Lead response rate',
    description: 'Share of leads someone has acted on rather than left at first contact.',
    formula: 'leads.responded / leads.count',
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: ['leads.responded', 'leads.count'],
    benchmark: null,
    thresholds: { good: 0.9, warning: 0.7 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    /* Deliberately not called a *reply* rate. See UNTOUCHED above: this is
       derived from status movement, not from contact events, because TeleCRM
       cannot serve those in a sync. `lead.response_minutes` — the median time
       to first response — genuinely needs the events and stays dashed until the
       webhook is delivering them. */
    aiContext: 'Measures leads worked, not leads replied to: it reads status movement because TeleCRM cannot serve contact events in a sync. A lead phoned without a status change looks unworked here. Never present it as a reply rate.',
  },
  {
    id: 'leads.interested_rate',
    name: 'Interested lead rate',
    description: 'Share of leads that reached interested or better.',
    formula: 'leads.interested / leads.count',
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: ['leads.interested', 'leads.count'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'A quality measure, not a volume one. It falls when a channel delivers more leads of the same quality, which is not the same as getting worse.',
  },
  {
    id: 'leads.ad_customers',
    name: 'Ad customers',
    description: 'Distinct people behind the leads paid media produced.',
    /* The base NC is read against, and a number worth having on its own: it is
       how many PEOPLE the advertising reached, where the lead count is how many
       times they wrote in. The two diverge by exactly the repeat rate. */
    source: (e) => customers(e.leads.filter(isAdLead)),
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'People, not enquiries: one person who wrote in four times counts once. Only leads the CRM tagged to Meta or Google are counted, so it is a floor on what the advertising reached, not a total.',
  },
  {
    id: 'leads.new_customers',
    name: 'NC customers',
    description: 'New customers — people from paid ads with no earlier enquiry in the last 365 days.',
    /* People, not enquiries, and first-time people at that. One person who
       writes in four times this month is one new customer; a returning guest is
       none, however many times they write in. */
    source: (e) => customers(e.leads.filter(isAdLead).filter(isNewCustomer)),
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'People enquiring for the first time, from paid leads only, judged against a 365-day lookback. It OVERSTATES while the store holds less than a year of history, because a guest whose earlier enquiry predates the data looks new — say so whenever the figure is quoted, and check how far the store actually reaches before drawing a conclusion about acquisition.',
  },
  {
    id: 'leads.new_customer_rate',
    name: 'NC %',
    description: 'Share of the people paid media produced who had never enquired before.',
    /* Customers over customers. Deduplicating one half only would divide people
       by enquiries and print a rate wrong by whatever the repeat rate was that
       month — wrong, and moving, so it would read as a trend. */
    formula: 'leads.new_customers / leads.ad_customers',
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Marketing Director',
    dependencies: ['leads.new_customers', 'leads.ad_customers'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    /* Which direction is "good" is a judgement this cannot make. High means the
       advertising is finding people the business has never spoken to; it also
       means it is not bringing anybody back. Marked `higher` because these are
       acquisition campaigns, not because a low figure is a fault. */
    aiContext: 'Both halves are people. High means paid media is reaching strangers rather than returning guests — which is what acquisition spend is for, but it is not automatically the better number for a resort with repeat business. It reads too high while the store holds under a year of history, since anybody whose earlier enquiry predates the data counts as new.',
  },
  {
    id: 'leads.repeat_customers',
    name: 'RC customers',
    description: 'Returning customers — people from paid ads who had enquired before, inside the last 365 days.',
    source: (e) => customers(e.leads.filter(isAdLead).filter(isReturningCustomer)),
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    /* **This reads near zero on paid leads, and that is a finding rather than
       a fault.** Of 475 Meta leads sampled from this workspace, ZERO shared a
       phone number with another Meta lead: people who come back do not fill in
       the ad form again, they call, walk in, or arrive through a travel agency.
       So the repeat business is real and is almost entirely invisible from
       inside an ads-only view. Reading it at `channel:non-ad` or unfiltered is
       where the number lives. */
    aiContext: 'Returning people among PAID leads only, which is why it reads far lower than the business\'s real repeat rate — in this workspace repeat guests overwhelmingly arrive through non-ad routes and never re-submit an ad form. Never present this as the repeat rate of the business. It also understates while the store holds under a year, since an earlier enquiry that predates the data cannot be seen.',
  },
  {
    id: 'leads.repeat_customer_rate',
    name: 'RC %',
    description: 'Share of the people paid media produced who had enquired before.',
    formula: 'leads.repeat_customers / leads.ad_customers',
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Marketing Director',
    dependencies: ['leads.repeat_customers', 'leads.ad_customers'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    /* Not 100 minus NC%. Somebody whose first enquiry AND second enquiry both
       fall inside the window is counted in both, so the two rates overlap
       rather than partition. */
    aiContext: 'Does not sum with NC % to 100 — a person whose first and second enquiries both fall inside the window is in both figures. Reads near zero on paid leads because returning guests re-enter through non-ad routes, so it measures re-engagement BY ADVERTISING rather than repeat business.',
  },
  {
    id: 'revenue.new_customers',
    name: 'NC reservation value',
    description: 'Reservation value from won leads whose customer was enquiring for the first time.',
    /* Deals carry the channel AND the first-time flag of the lead they came
       from — a deal has neither of its own. `repeat === false` here for the
       same reason it is used on leads: a deal whose lead cannot be found
       carries null, and null must not be read as new. */
    source: (e) => sum((e.deals || []).filter((d) => PAID_CHANNEL.has(d.channel)
      && d.repeat === false
      && d.outcome === 'won'
      && !CANCELLED.test(String(d.bookingStatus || ''))), 'revenue'),
    sources: ['crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'A floor, not a total: only deals whose lead was tagged to a paid channel AND identifiable as a first-time customer are counted. Cancellations excluded. Understates whenever a won lead has no reservation value entered.',
  },
  {
    id: 'roas.new_customers',
    name: 'NC ROAS',
    description: 'Reservation value from first-time customers, against the ad spend that produced them.',
    formula: 'revenue.new_customers / ads.spend',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['revenue.new_customers', 'ads.spend'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'ratio', decimals: 1, suffix: 'x' },
    /* **The two halves are not symmetrical, and that is the whole caveat.**
     *
     * The numerator is narrow: paid-tagged, first-time, won, not cancelled, and
     * with a value somebody actually typed in. The denominator is ALL paid
     * spend — including the spend that produced returning customers, and the
     * spend that produced leads the CRM never tagged.
     *
     * So this reads LOW by construction and is a floor on acquisition return,
     * never a measure of campaign performance. It is the honest direction to
     * err: the alternative, dividing by "spend attributable to new customers",
     * is not a number any platform reports and would have to be invented.
     *
     * This is the opposite failure from the blended ROAS trap, where ALL
     * reservation value was divided by paid spend alone and read 19x because
     * 93% of it came from leads nobody paid for. Here both restrictions land on
     * the numerator, so the error runs downward. */
    aiContext: 'A FLOOR on acquisition return, not campaign performance. The numerator counts only won, uncancelled, paid-tagged deals from identifiable first-time customers with a reservation value entered; the denominator is every rupee of paid spend, including what produced returning guests and untagged leads. Never compare it against a platform-reported ROAS, and never call it low performance without saying which side is restricted.',
  },
  {
    id: 'leads.new_customers_interested',
    name: 'NC interested leads',
    description: 'New customers from paid ads who reached interested or better.',
    /* The two conditions are asked of the PERSON, not of one enquiry: a
       customer counts if they are new AND any of their enquiries reached
       interested. Testing a single lead for both would miss the ordinary case
       where somebody enquires, is marked Fresh, and is moved to Interested on a
       second enquiry a week later. */
    source: (e) => {
      const ad = e.leads.filter(isAdLead);
      const fresh = new Set(ad.filter(isNewCustomer).map(keyOf));
      const keen = new Set(ad.filter((l) => INTERESTED.test(String(l.stage || ''))).map(keyOf));
      let n = 0;
      for (const id of fresh) if (keen.has(id)) n += 1;
      return n;
    },
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'First-time people from paid ads who showed interest. Both conditions are about the person, not one enquiry, so somebody marked Fresh on their first message and Interested on their second is counted. Interest is read from status words, not a typed field, so it understates.',
  },
  {
    id: 'leads.new_customers_interested_rate',
    name: 'NC interested leads %',
    description: 'Share of new customers from paid ads who reached interested or better.',
    /* Against new customers, not against every customer — this answers "how
       good is the demand we are acquiring", and dividing by the whole base
       would blend it with the quality of returning guests, who are a different
       population and usually a warmer one. */
    formula: 'leads.new_customers_interested / leads.new_customers',
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: ['leads.new_customers_interested', 'leads.new_customers'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'The quality of newly acquired demand, measured in people. Its base is new customers rather than all customers, so it is not comparable with the overall interested rate — returning guests are a warmer population and are deliberately excluded from both halves.',
  },
  {
    id: 'cost.per_interested_lead',
    name: 'Cost per interested lead',
    description: 'Ad spend divided by the leads that reached interested or better.',
    formula: 'ads.spend / leads.interested',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'leads.interested'],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'The cost measure worth optimising, since a cheap lead that never engages is not cheap. Compare it across channels, never against a raw CPL.',
  },
  {
    id: 'bookings.reservations',
    name: 'Reservations (CRM)',
    description: 'Won leads whose reservation has not been cancelled.',
    /* The same exclusion `revenue.reservations` makes, applied to the count —
       or a cancelled booking would keep inflating the denominator of every cost
       per booking after it was cancelled. */
    source: (e) => (e.deals || []).filter((d) => d.outcome === 'won' && !CANCELLED.test(String(d.bookingStatus || ''))).length,
    sources: ['crm'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'The CRM\'s count of won leads, not the PMS\'s confirmed bookings. The two will differ and the CRM is the earlier of them.',
  },
  {
    id: 'revenue.attributed',
    name: 'Attributed revenue',
    description: 'Reservation value on leads the CRM tagged to a paid channel.',
    /* This card carried no metric for a long time, and the comment beside it
       was right: `revenue.net` is every booking, paid or not, so pointing the
       card at it would have credited paid media with the whole direct and
       organic contribution.
     *
     * What changed is that leads now carry a channel and deals inherit it, so
     * "revenue credited to paid media" is answerable — it is the reservation
     * value of deals whose lead was tagged meta or google. An untagged deal is
     * excluded, which is why this is a floor: it counts what can be shown, not
     * everything paid media caused. */
    source: (e) => sum((e.deals || []).filter((d) => PAID_CHANNEL.has(d.channel)
      && d.outcome === 'won' && !CANCELLED.test(String(d.bookingStatus || ''))), 'revenue'),
    sources: ['crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'A floor, not a total: only leads the CRM tagged with a channel are counted, and most of this workspace\'s leads are untagged. Never present it as everything paid media produced.',
  },
  {
    id: 'roas.attributed',
    name: 'ROAS (attributed)',
    description: 'Reservation value from leads tagged to a paid channel, against ad spend.',
    /* The honest counterpart to `roas.reservations`, which divides EVERY
     * reservation the CRM holds by paid spend alone and read **22.6x** on the
     * marketing dashboard. Nothing returned 22.6x: most of that revenue came
     * from walk-ins, referrals and direct calls that no advertising was paid
     * for, and the ratio put all of it above a denominator only the ads
     * contributed to. A number that flattering is worse than a missing one.
     *
     * Here both halves are paid-tagged, so it is a comparison rather than a
     * collision. It reads far lower and it is a FLOOR — an untagged lead is
     * outside the numerator — which is the direction to err in. */
    formula: 'revenue.attributed / ads.spend',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['revenue.attributed', 'ads.spend'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'ratio', decimals: 1, suffix: 'x' },
    aiContext: 'Both halves are paid-tagged, unlike the blended ROAS which divides all CRM reservation value by ad spend alone. It is a floor: leads the CRM never tagged are excluded from the numerator but their spend is still in the denominator. Prefer this one whenever the question is what the advertising returned.',
  },
  {
    id: 'revenue.per_reservation',
    name: 'Average reservation value',
    description: 'The CRM\'s reservation value divided by the reservations it recorded.',
    formula: 'revenue.reservations / bookings.reservations',
    sources: ['crm'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: ['revenue.reservations', 'bookings.reservations'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    /* Both halves exclude cancellations, so the same set is on top and bottom.
       What they do not share is completeness: `reservation_value` is a field
       somebody fills in, and a won lead where nobody did counts in the
       denominator with nothing above it. So this reads low by whatever share of
       won leads has no figure entered — stated in the AI context rather than
       corrected here, because dividing by "deals that happen to carry a value"
       would make this average disagree with the reservation count beside it,
       and a number that cannot be reconciled with its neighbour is worse than
       one that is understated for a reason. */
    aiContext: 'Understates whenever a won lead has no reservation value entered, since those count in the denominator. A mix measure: it moves when the kind of booking changes, not when more arrive. Compare across channels for stay value, never to judge volume.',
  },
  {
    id: 'cost.per_reservation',
    name: 'Cost per reservation (CRM)',
    description: 'Ad spend divided by reservations the CRM records as won.',
    formula: 'ads.spend / bookings.reservations',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'bookings.reservations'],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Uses the CRM\'s won count, so it is available before the PMS confirms anything — and will move when it does.',
  },
  {
    id: 'roas.reservations',
    name: 'ROAS (CRM reservations)',
    description: 'Reservation value the CRM records, against ad spend.',
    formula: 'revenue.reservations / ads.spend',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['revenue.reservations', 'ads.spend'],
    benchmark: { target: 4.0, category: 3.4 },
    thresholds: { good: 4.0, warning: 3.0 },
    favourability: 'higher',
    format: { kind: 'ratio', decimals: 1, suffix: 'x' },
    /* Not `roas.net`, and the difference is the whole reason both exist: that
       one is settled folio revenue over spend, this one is what a salesperson
       entered at conversion. Presenting either as the other would be the
       quietest possible way to overstate a return. */
    aiContext: 'Built on CRM reservation value, not settled revenue, and only on leads the CRM tagged with a channel — so it is a floor. Never call it net ROAS.',
  },
  {
    id: 'leads.conversion_rate',
    name: 'Lead → won rate',
    description: 'Share of leads that became a won reservation.',
    formula: 'bookings.reservations / leads.count',
    sources: ['crm'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: ['bookings.reservations', 'leads.count'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Leads and wins are dated independently — a lead from March that converts in August lands in different periods. Over a short window this reads low for that reason alone.',
  },
  {
    id: 'leads.interested_to_won',
    name: 'Interested → won rate',
    description: 'Share of interested leads that became a won reservation.',
    formula: 'bookings.reservations / leads.interested',
    sources: ['crm'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: ['bookings.reservations', 'leads.interested'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Measures the sales team rather than the channel: by this point the lead has already shown intent. A channel comparison here is about lead quality, not about closing.',
  },

  {
    id: 'revenue.reservations',
    name: 'Reservation value (CRM)',
    description: 'What the CRM records as the value of reservations on won leads, in the period.',
    /* Deliberately NOT folded into `revenue.net`.
     *
     * The precedence table gives settled revenue to the PMS folio, and this is
     * not that: it is what the salesperson entered when the lead converted, on
     * a deal that may still cancel and has not been reconciled against anything
     * that took money. Merging the two would let a CRM figure answer a question
     * about settled revenue, and nobody reading `revenue.net` would know which
     * one they had.
     *
     * It earns its own entry because with no PMS connected it is the only
     * revenue that exists, and declining to show a figure the source actually
     * reports is the same failure as inventing one. When a PMS arrives this
     * stays, beside the folio, and the difference between them becomes worth
     * reading on its own. */
    /* Cancelled reservations are excluded, not netted off.
     *
     * A won lead whose booking was later cancelled keeps its reservation value
     * in the CRM — six of them here, ₹2.81L — so summing every deal counted
     * money nobody is going to receive. The same rule the OTA screen already
     * follows: the cancellation is counted, its money is not.
     *
     * Matched on the word rather than an enum because `booking_status` is a
     * workspace custom field with no fixed vocabulary; anything that is not
     * cancelled still counts, so a status this does not recognise fails
     * towards including real revenue rather than hiding it. */
    source: (e) => sum((e.deals || []).filter((d) => d.outcome === 'won' && !CANCELLED.test(String(d.bookingStatus || ''))), 'revenue'),
    sources: ['crm'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Entered by a salesperson at conversion, not settled through a folio or a payment gateway. Always say it is the CRM figure, and never present it as collected revenue.',
  },
  {
    id: 'revenue.net',
    name: 'Revenue (net)',
    description: 'Settled room and extras revenue on confirmed bookings, after cancellations.',
    /* The PMS folio, not the CRM deal value — the precedence decision made in
       sub-phase 4.4, carried through so the registry cannot quietly disagree
       with the entity it reads. */
    source: (e) => sum(e.bookings.map((b) => ({ v: value(b.revenue) || 0 })), 'v'),
    sources: ['pms', 'crm'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Folio-settled, so it lags a booking by the length of the stay. A gap against CRM deal value is expected and is not an error.',
  },
  {
    id: 'bookings.confirmed',
    name: 'Confirmed bookings',
    description: 'Bookings that settled with revenue attached.',
    source: (e) => e.bookings.filter((b) => (value(b.revenue) || 0) > 0).length,
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A cancelled booking settles at zero and is excluded here, so this can fall while gross bookings rise.',
  },
  {
    id: 'leads.count',
    name: 'Leads',
    description: 'Enquiries the CRM recorded in the period.',
    source: (e) => e.leads.length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts enquiries, not people. One guest enquiring twice is two leads until identity resolution merges them.',
  },

  {
    id: 'leads.open',
    name: 'Open leads',
    description: 'Leads the CRM has neither booked nor lost.',
    /* Stage comes through `n.text`, which title-cases, so it is lowered before
       comparing — the same trap that made lead response read zero events. */
    source: (e) => e.leads.filter((l) => !['booked', 'lost', 'closed-won', 'closed-lost'].includes(String(l.stage || '').toLowerCase())).length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A stock, not a flow — it rises when leads arrive and falls when they resolve either way. A rise is not by itself good news.',
  },
  {
    id: 'leads.unanswered',
    name: 'Unanswered leads',
    description: 'Leads with no first response logged against them.',
    /* A period narrows *which* leads are considered; this counts the ones among
       them nobody replied to. Pairing it with the `last-2h` period — everything
       older than two hours — is what answers "Untouched > 2h" without the
       metric knowing anything about two hours. */
    source: (e) => {
      const answered = new Set(
        (e.leadEvents || [])
          .filter((ev) => String(ev.type || '').toLowerCase() === 'first_response')
          .map((ev) => ev.leadId)
      );
      return e.leads.filter((l) => !answered.has(l.id)).length;
    },
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: { good: 0, warning: 5 },
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts leads with no logged first response. A lead answered outside the CRM looks unanswered here, so treat it as an upper bound on neglect rather than a certainty.',
  },
  {
    id: 'leads.lost',
    name: 'Lost leads',
    description: 'Leads the CRM marked lost.',
    source: (e) => e.leads.filter((l) => ['lost', 'closed-lost'].includes(String(l.stage || '').toLowerCase())).length,
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts leads explicitly marked lost. A lead quietly abandoned is still open here, so this understates true loss.',
  },
  {
    id: 'ads.impressions',
    name: 'Impressions',
    description: 'Times an ad was shown, across both platforms.',
    source: (e) => sum(e.campaignDays, 'impressions'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A reach measure, not a performance one. Never cite a rise in impressions as evidence of improvement on its own.',
  },
  {
    id: 'ads.clicks',
    name: 'Clicks',
    description: 'Clicks on an ad, across both platforms.',
    source: (e) => sum(e.campaignDays, 'clicks'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Platform-reported. Clicks and site sessions will not agree, and the gap is not an error.',
  },
  {
    id: 'ads.reported_leads',
    name: 'Platform-reported leads',
    description: 'Leads the ad platforms claim, before the CRM confirms them.',
    /* Deliberately separate from `leads.count`. The platforms report far more
       than the CRM records, and collapsing the two would hide exactly the gap
       identity resolution exists to measure. */
    source: (e) => sum(e.campaignDays, 'leads'),
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Not the same as CRM leads and usually higher. Cite the CRM figure for anything about pipeline; cite this only for delivery.',
  },
  {
    id: 'ads.ctr',
    name: 'CTR',
    description: 'Share of impressions that produced a click.',
    formula: 'ads.clicks / ads.impressions',
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.clicks', 'ads.impressions'],
    benchmark: { target: 0.03, category: 0.024 },
    thresholds: { good: 0.03, warning: 0.015 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 2 },
    aiContext: 'Creative and audience quality together. A falling CTR beside steady bookings is a reach problem, not a conversion one.',
  },
  {
    id: 'ads.cpm',
    name: 'CPM',
    description: 'Cost of a thousand impressions.',
    formula: 'ads.spend * 1000 / ads.impressions',
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'ads.impressions'],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'An auction-price measure. A rising CPM with steady CTR is competition, not creative fatigue.',
  },

  {
    id: 'inventory.available',
    name: 'Available room nights',
    description: 'Room nights the properties had to sell in the period.',
    source: (e) => sum(e.inventoryDays || [], 'available'),
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Capacity, not demand. It moves only when rooms are taken out of service or added.',
  },
  {
    id: 'inventory.sold',
    name: 'Room nights sold (PMS)',
    description: 'Room nights the PMS recorded as sold.',
    /* Distinct from `stay.room_nights`, which counts nights on bookings that
       settled with revenue. This is the PMS's own nightly count and will not
       agree exactly — one is billing, the other is housekeeping. */
    source: (e) => sum(e.inventoryDays || [], 'sold'),
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'The PMS nightly count, not the billed one. Expect it to differ from room nights on settled bookings.',
  },
  {
    id: 'occupancy.rate',
    name: 'Occupancy',
    description: 'Room nights sold against room nights available.',
    formula: 'inventory.sold / inventory.available',
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: ['inventory.sold', 'inventory.available'],
    benchmark: { target: 0.82, category: null },
    thresholds: { good: 0.82, warning: 0.7 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 0 },
    aiContext: 'Occupancy bought by discounting is not the same as occupancy earned. Always read it beside ADR before calling a rise good.',
  },
  {
    id: 'rate.revpar',
    name: 'RevPAR',
    description: 'Net revenue for every room night available, sold or not.',
    formula: 'revenue.net / inventory.available',
    sources: ['pms'],
    refresh: 'hourly',
    owner: 'Revenue Manager',
    dependencies: ['revenue.net', 'inventory.available'],
    benchmark: { target: 697300, category: null },
    thresholds: { good: 697300, warning: 500000 },
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'The one figure that cannot be gamed by trading rate against occupancy, because it carries both.',
  },

  {
    id: 'bookings.all',
    name: 'Bookings (all)',
    description: 'Every booking the PMS holds for the period, cancelled or not.',
    source: (e) => e.bookings.length,
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A denominator, not a performance figure. Use confirmed bookings for anything about delivery.',
  },
  {
    id: 'bookings.cancelled',
    name: 'Cancelled bookings',
    description: 'Bookings the PMS marked cancelled.',
    source: (e) => e.bookings.filter((b) => String(value(b.bookingStatus) || '').toLowerCase() === 'cancelled').length,
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Status comes from the PMS, which wins that field over the CRM. A CRM deal still open against a cancelled booking is expected.',
  },
  {
    id: 'cancellation.rate',
    name: 'Cancellation rate',
    description: 'Share of bookings that were cancelled.',
    formula: 'bookings.cancelled / bookings.all',
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['bookings.cancelled', 'bookings.all'],
    benchmark: { target: 0.034, category: null },
    thresholds: { good: 0.034, warning: 0.06 },
    favourability: 'lower',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Cancellations concentrate near the payment window. Check the window length before attributing a rise to demand.',
  },
  /* ── Channel production ────────────────────────────────────────────────────
   *
   * What the OTAs sold and what they kept. Separate from the `revenue.*` and
   * `bookings.*` metrics above and **never to be added to them**: those read
   * the PMS's bookings and these read the channels' reservations, and the same
   * stay appears in both the day the PMS is connected. Summing the two would
   * double-count every reservation that arrived twice. The reconciliation is by
   * confirmation number and is not built — see the note on `otaReservations` in
   * lib/ingest/canonical.js.
   *
   * Cancelled reservations are excluded from every money figure and counted in
   * `ota.cancellations`, so a channel cannot improve its revenue by selling
   * stays that fall through. `(e.otaReservations || [])` throughout, because
   * lib/metrics/scope.js hands a narrowed entity set that does not carry this
   * collection — an OTA figure is a workspace question, not a per-campaign one.
   */
  {
    id: 'ota.gross_revenue',
    name: 'OTA gross revenue',
    description: 'What guests paid the channels for confirmed reservations, before commission.',
    source: (e) => ota.total((e.otaReservations || []).filter(ota.isConfirmed), 'gross'),
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'The guest-facing figure, not what the property banks — always pair it with commission or net. It is the channel\'s own account of the stay and is not reconciled against the PMS folio.',
  },
  {
    id: 'ota.commission',
    name: 'OTA commission',
    description: 'What the channels billed on confirmed reservations.',
    source: (e) => ota.total((e.otaReservations || []).filter(ota.isConfirmed), 'commission'),
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'The cost of the channel, and the one number only the channel has — a PMS folio shows what was banked and cannot say what was kept.',
  },
  {
    id: 'ota.net_revenue',
    name: 'OTA net revenue',
    description: 'What the property banks from the channels, after commission.',
    formula: 'ota.gross_revenue - ota.commission',
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['ota.commission', 'ota.gross_revenue'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'The figure a channel-mix decision should be made on. Ranking channels by gross reverses the order whenever their commission rates differ, which here they do by a factor of six.',
  },
  {
    id: 'ota.reservations',
    name: 'OTA reservations',
    description: 'Confirmed reservations across every connected channel.',
    source: (e) => (e.otaReservations || []).filter(ota.isConfirmed).length,
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts reservations, not stays or guests. A modified reservation is one reservation.',
  },
  {
    id: 'ota.reservations_all',
    name: 'OTA reservations (all)',
    description: 'Every reservation the channels reported, cancellations included.',
    source: (e) => (e.otaReservations || []).length,
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'neutral',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A denominator, not a performance figure. Use confirmed reservations for anything about delivery.',
  },
  {
    id: 'ota.cancellations',
    name: 'OTA cancellations',
    description: 'Channel reservations that cancelled or no-showed.',
    source: (e) => (e.otaReservations || []).filter(ota.isCancelled).length,
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'A no-show is counted here with a cancellation: both are a sold night that was not stayed, which is what the figure is for.',
  },
  {
    id: 'ota.cancellation_rate',
    name: 'OTA cancellation rate',
    description: 'Share of channel reservations that fell through.',
    formula: 'ota.cancellations / ota.reservations_all',
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['ota.cancellations', 'ota.reservations_all'],
    benchmark: null,
    thresholds: { good: 0.05, warning: 0.15 },
    favourability: 'lower',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Channels differ in this by design — a free-cancellation rate sells more and falls through more. Compare a channel against itself over time before comparing it against another.',
  },
  {
    id: 'ota.room_nights',
    name: 'OTA room nights',
    description: 'Nights sold through the channels on confirmed reservations.',
    source: (e) => ota.total((e.otaReservations || []).filter(ota.isConfirmed), 'nights'),
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Nights, not reservations — a three-night stay is one reservation and three nights, and the ADR below divides by these.',
  },
  {
    id: 'ota.adr',
    name: 'OTA rate per night',
    description: 'Average nightly rate guests paid through the channels.',
    /* Gross, not net: this is the rate the guest saw, which is what a rate
       comparison between channels is made on. The commission comes off it
       separately, in `ota.commission_rate` right below. */
    formula: 'ota.gross_revenue / ota.room_nights',
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['ota.gross_revenue', 'ota.room_nights'],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Guest-paid, so it is not comparable with the direct ADR in rate.adr, which is folio-settled and net of commission by construction.',
  },
  {
    id: 'ota.commission_rate',
    name: 'OTA commission rate',
    description: 'The share of channel revenue the channels kept.',
    /* Effective, not contracted. This is what the channels actually took over
       the window; the contracted rate lives in an agreement nothing here
       reads, and the two differ whenever a promotion or a penalty applies. */
    formula: 'ota.commission / ota.gross_revenue',
    sources: ['ota'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['ota.commission', 'ota.gross_revenue'],
    benchmark: null,
    thresholds: { good: 0.15, warning: 0.2 },
    favourability: 'lower',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'An effective rate across a mix of channels, so it moves when the mix moves even if no channel changed its terms. Say which of the two happened before calling it a rise in cost.',
  },

  {
    id: 'lead.response_minutes',
    name: 'Lead response',
    description: 'Median minutes from a lead arriving to its first response.',
    /* Median, not mean: one lead answered three days late would drag an
       average past anything a manager would recognise. */
    source: (e) => {
      const byLead = new Map(e.leads.map((l) => [l.id, l]));
      const waits = [];
      for (const event of e.leadEvents || []) {
        /* Compared case-insensitively on purpose: this metric silently read
           zero events for its first run because stage 2 was title-casing the
           type. The mapper is fixed, and this stays lenient so a future
           normalisation change cannot break it back without anyone noticing. */
        if (String(event.type || '').toLowerCase() !== 'first_response') continue;
        const lead = byLead.get(event.leadId);
        if (!lead || !lead.createdAt || !event.at) continue;
        const minutes = (Date.parse(event.at) - Date.parse(lead.createdAt)) / 60000;
        if (Number.isFinite(minutes) && minutes >= 0) waits.push(minutes);
      }
      if (!waits.length) return null;
      waits.sort((a, b) => a - b);
      const mid = Math.floor(waits.length / 2);
      return waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2;
    },
    sources: ['crm'],
    refresh: 'realtime',
    owner: 'Sales Manager',
    dependencies: [],
    benchmark: { target: 44, category: null },
    thresholds: { good: 44, warning: 120 },
    favourability: 'lower',
    format: { kind: 'duration', decimals: 0, unit: 'min' },
    aiContext: 'Only leads with a logged first response are counted; an unanswered lead is absent, not slow. Say so when the count is small.',
  },

  {
    id: 'stay.room_nights',
    name: 'Room nights sold',
    description: 'Nights stayed across bookings that settled with revenue.',
    source: (e) => e.bookings.filter((b) => (value(b.revenue) || 0) > 0).reduce((t, b) => t + (b.nights || 0), 0),
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: [],
    benchmark: null,
    thresholds: null,
    favourability: 'higher',
    format: { kind: 'count', decimals: 0 },
    aiContext: 'Counts nights, not bookings — a three-night stay is three. Do not use it as a booking count.',
  },

  /* — derived — */

  {
    id: 'roas.net',
    name: 'Net ROAS',
    description: 'Net revenue for every rupee of ad spend, credited by the workspace attribution model.',
    formula: 'revenue.net / ads.spend',
    sources: ['crm', 'pms', 'ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['revenue.net', 'ads.spend'],
    benchmark: { target: 4.0, category: 3.4 },
    thresholds: { good: 4.0, warning: 3.0 },
    favourability: 'higher',
    format: { kind: 'ratio', decimals: 1, suffix: 'x' },
    aiContext: 'Follows the workspace attribution model, so it moves when the model changes without any underlying performance change. Say which model is in force before calling a shift real.',
  },
  {
    id: 'cost.per_booking',
    name: 'Cost per booking',
    description: 'Ad spend divided by the bookings that settled with revenue.',
    formula: 'ads.spend / bookings.confirmed',
    sources: ['ads', 'pms'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'bookings.confirmed'],
    benchmark: { target: 350000, category: null },
    thresholds: { good: 350000, warning: 500000 },
    /* Lower is better, which is exactly the case the favourability field
       exists for: the same colour rule applied to ROAS would paint a falling
       cost red. */
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Rises when bookings lag spend, which is normal early in a booking window. Compare against the booking lead time before calling it inefficiency.',
  },
  {
    id: 'cost.per_lead',
    name: 'Cost per lead',
    description: 'Ad spend divided by the enquiries it produced.',
    formula: 'ads.spend / leads.count',
    sources: ['ads', 'crm'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'leads.count'],
    benchmark: { target: 35000, category: 42000 },
    thresholds: { good: 35000, warning: 50000 },
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'A delivery-side efficiency measure. A falling CPL beside a falling booking rate is worse news than a rising CPL alone.',
  },
  {
    id: 'cost.per_reported_lead',
    name: 'Cost per reported lead',
    description: 'Ad spend divided by the leads the platforms claim, before the CRM confirms them.',
    /* Deliberately separate from `cost.per_lead`, for the same reason
       `ads.reported_leads` is separate from `leads.count`: the platforms report
       more leads than the CRM records, and one number covering both would hide
       the gap identity resolution exists to measure.
       It exists because a panel headed "synced from Meta Ads" was showing
       `cost.per_lead`, which divides by CRM leads — so on a campaign the CRM has
       never heard of it read "—" while the table one click away showed a CPL for
       that same campaign. Both were right about different things, which is the
       worst way for two numbers to disagree. */
    formula: 'ads.spend / ads.reported_leads',
    sources: ['ads'],
    refresh: '15min',
    owner: 'Marketing Director',
    dependencies: ['ads.spend', 'ads.reported_leads'],
    benchmark: null,
    thresholds: null,
    favourability: 'lower',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Platform-reported and therefore optimistic: it counts leads the CRM may never receive. Cite cost.per_lead for anything about pipeline economics, and this one only for delivery efficiency.',
  },
  {
    id: 'booking.value',
    name: 'Average booking value',
    description: 'Net revenue divided by the bookings that produced it.',
    formula: 'revenue.net / bookings.confirmed',
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['revenue.net', 'bookings.confirmed'],
    benchmark: { target: 3140000, category: null },
    thresholds: { good: 3140000, warning: 2500000 },
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Moves with room mix and length of stay as much as with pricing. Do not attribute a change to rate without checking nights and room type.',
  },
  {
    id: 'rate.adr',
    name: 'ADR',
    description: 'Average daily rate — net revenue divided by the room nights that earned it.',
    /* Per room *night*, which is what makes ADR different from average booking
       value: a three-night stay is three nights, not one sale. */
    formula: 'revenue.net / stay.room_nights',
    sources: ['pms'],
    refresh: '15min',
    owner: 'Revenue Manager',
    dependencies: ['revenue.net', 'stay.room_nights'],
    benchmark: { target: 894000, category: null },
    thresholds: { good: 894000, warning: 700000 },
    favourability: 'higher',
    format: { kind: 'currency', decimals: 0 },
    aiContext: 'Rate per night, independent of how many nights were sold. Pair it with room nights before calling a change a pricing decision — mix shifts move it too.',
  },
  {
    id: 'lead.conversion',
    name: 'Lead → booking rate',
    description: 'The share of enquiries that became a booking with revenue.',
    formula: 'bookings.confirmed / leads.count',
    sources: ['crm', 'pms'],
    refresh: '15min',
    owner: 'Sales Manager',
    dependencies: ['bookings.confirmed', 'leads.count'],
    benchmark: { target: 0.161, category: null },
    thresholds: { good: 0.161, warning: 0.1 },
    favourability: 'higher',
    format: { kind: 'percent', decimals: 1 },
    aiContext: 'Enquiries and bookings settle on different clocks — a booking may belong to a lead from a previous period. Treat short-window readings as provisional.',
  },
];

/* ── validation ─────────────────────────────────────────────────────────── */

const TWELVE = ['id', 'name', 'description', 'sources', 'refresh', 'owner',
  'dependencies', 'benchmark', 'thresholds', 'favourability', 'format', 'aiContext'];

/* `benchmark` and `thresholds` may be null — a base metric legitimately has no
   target — but the key must be present. Absent and null are different claims:
   one is an omission, the other is a decision. */
function assertMetric(metric) {
  for (const field of TWELVE) {
    if (!Object.prototype.hasOwnProperty.call(metric, field)) {
      throw new Error(`metric "${metric.id || '(no id)'}" is missing ${field}`);
    }
  }

  const hasFormula = typeof metric.formula === 'string';
  const hasSource = typeof metric.source === 'function';
  if (hasFormula === hasSource) {
    throw new Error(`metric "${metric.id}" must have either a formula or a source, not ${hasFormula ? 'both' : 'neither'}`);
  }

  if (!REFRESH.includes(metric.refresh)) throw new Error(`metric "${metric.id}" has refresh "${metric.refresh}"`);
  if (!FAVOURABILITY.includes(metric.favourability)) throw new Error(`metric "${metric.id}" has favourability "${metric.favourability}"`);
  if (!metric.format || !FORMATS.includes(metric.format.kind)) throw new Error(`metric "${metric.id}" has no valid format`);
  if (!Array.isArray(metric.sources) || !metric.sources.length) throw new Error(`metric "${metric.id}" names no source system`);
  if (!metric.aiContext) throw new Error(`metric "${metric.id}" has no ai_context — the AI would be free to assert anything about it`);

  /* A declared dependency list that disagrees with the formula is worse than
     none: the calculation order comes from one and the impact analysis from
     the other, so they would silently diverge. */
  if (hasFormula) {
    const actual = references(compile(metric.formula));
    const declared = [...metric.dependencies].sort();
    if (JSON.stringify(actual.slice().sort()) !== JSON.stringify(declared)) {
      throw new Error(`metric "${metric.id}" declares dependencies [${declared}] but its formula uses [${actual.slice().sort()}]`);
    }
  } else if (metric.dependencies.length) {
    throw new Error(`metric "${metric.id}" reads a source directly and cannot also declare dependencies`);
  }

  return metric;
}

const BY_ID = {};
for (const metric of METRICS) {
  assertMetric(metric);
  if (BY_ID[metric.id]) throw new Error(`duplicate metric id "${metric.id}"`);
  BY_ID[metric.id] = metric;
}

/* Every dependency must exist, or calculation order is a lie. */
for (const metric of METRICS) {
  for (const dep of metric.dependencies) {
    if (!BY_ID[dep]) throw new Error(`metric "${metric.id}" depends on "${dep}", which is not in the registry`);
  }
}

const list = () => METRICS.slice();
const get = (id) => BY_ID[id] || null;
const ids = () => METRICS.map((m) => m.id);

/* INTERESTED and CANCELLED are exported so the marketing funnel classifies a
   qualified lead the same way the interested-rate tile does. Two screens a
   click apart disagreeing about what "qualified" means is the drift this
   registry exists to prevent. */
module.exports = {
  METRICS, BY_ID, list, get, ids, assertMetric, TWELVE, REFRESH, FAVOURABILITY, FORMATS,
  INTERESTED, CANCELLED, UNTOUCHED,
  /* Exported for the same reason: anything that wants to show which leads sit
     behind the NC tiles — a filtered table, a drill-down — must decide "new"
     with this predicate and not with a rule of its own. */
  isNewCustomer, isReturningCustomer, isAdLead,
};
