/* Figures the design draws as literal text rather than as `{{ }}`.
 *
 * A Claude Design file interpolates data through `sc-for` and `{{ }}`, but a
 * hand-drawn SVG has neither — so the attribution Sankey's node labels are
 * typed straight into the markup. They therefore never re-credit when the
 * attribution model changes, and the diagram ends up contradicting the table
 * beneath it on the same screen. That was Phase 2's one remaining known flaw.
 *
 * Binding them here rather than editing `views/screens/` keeps the rule that
 * generated views are never hand-edited: the **conversion** owns the change, so
 * a re-run against the real design file reproduces it rather than silently
 * dropping it. `tools/rebind.js` applies the same function to views that were
 * already generated.
 *
 * Each binding must be an exact literal that appears **exactly once** in its
 * screen. A `find` matching twice would bind the wrong node with no sign of it,
 * so that is an error rather than a first-match-wins guess.
 *
 * Applying this twice is a no-op: after the first pass the literal is gone.
 */

const LITERAL_BINDINGS = [
  /* The creative card's middle metric was HOOK RATE, which is a video statistic
     this product does not fetch and cannot compute — it renders "—" on every
     row and always will. Cost per lead can be computed from what Meta already
     reports at ad level, and is the number this screen is read for. So the cell
     is re-labelled rather than left dead. Both halves are bound: a label
     changed without its value would be worse than either. */
  {
    screen: 'creatives',
    find: '>HOOK RATE<',
    replace: '>CPL<',
    relabel: true,
    why: 'hook rate is not fetchable; the cell carries cost per lead instead',
  },
  {
    screen: 'creatives',
    find: '<%= cr.hookRate %>',
    replace: '<%= cr.cpl %>',
    pairedWith: '>HOOK RATE<',
    why: 'the value beneath the re-labelled CPL cell',
  },
  /* Three cells the design gave to figures Meta cannot supply — bookings,
     revenue and net ROAS all need PMS and CRM data that is still fixtures —
     re-labelled to three it can. The values move with them, below. */
  {
    screen: 'creatives',
    find: '>BOOKINGS<',
    replace: '>CPM<',
    relabel: true,
    valueFrom: 'cr.bookings',
    why: 'bookings need PMS revenue; CPM is fetched and judges reach cost',
  },
  {
    screen: 'creatives',
    find: '>REVENUE<',
    replace: '>FREQUENCY<',
    relabel: true,
    valueFrom: 'cr.rev',
    why: 'revenue needs the CRM; frequency is fetched and is the first fatigue signal',
  },
  {
    screen: 'creatives',
    find: '>NET ROAS<',
    replace: '>CPC<',
    relabel: true,
    valueFrom: 'cr.roas',
    why: 'ROAS needs attributed revenue; cost per click is derivable from spend and clicks',
  },
  /* The six metric cells, re-pointed at the funnel the resort actually has:
     Ad -> Lead -> Interested Lead -> Booking -> Revenue. The labels the design
     drew (SPEND / CPM / FREQUENCY / NET ROAS) named platform delivery, which is
     what a media buyer reads *after* deciding the creative is worth keeping.
     Those figures now live in the row's tooltip rather than being dropped. */
  {
    screen: 'creatives',
    find: '>SPEND<',
    replace: '>COST / INT. LEAD<',
    relabel: true,
    valueFrom: 'cr.spend',
    why: 'the measure the whole score turns on deserves the first cell; total spend moves to the score row',
  },
  {
    screen: 'creatives',
    find: '>CPM<',
    replace: '>INT. LEAD RATE<',
    relabel: true,
    valueFrom: 'cr.bookings',
    why: 'lead quality is the thing CPM cannot see',
  },
  {
    screen: 'creatives',
    find: '>FREQUENCY<',
    replace: '>BOOKING RATE<',
    relabel: true,
    valueFrom: 'cr.rev',
    why: 'what the leads actually did',
  },
  {
    screen: 'creatives',
    find: '>CPC<',
    replace: '>ROAS<',
    relabel: true,
    valueFrom: 'cr.roas',
    why: 'what came back for what went out',
  },
  /* Three more cells, so the card carries the whole funnel rather than half of
     it. Anchored on the CTR cell's closing tags, which the replacement rewrites
     with a marker so it cannot match twice. */
  /* One binding, not two: the CTR cell is rewritten with a marker attribute so
     the pattern cannot match its own output, and the three new cells ride in the
     same replacement. Labels are HOOK and HOLD rather than "HOOK RATE" and
     "HOLD RATE" — both of those literals are the find of an earlier binding in
     this list, and re-introducing one would have a later rebind relabel a cell
     that was never the one meant. */
  {
    screen: 'creatives',
    find: '<div><div style="font-size:9.5px; color:var(--color-neutral-600);">CTR</div><div style="font-size:12px; font-weight:500; font-variant-numeric:tabular-nums;"><%= cr.ctr %></div></div>',
    replace: [
      '<div data-li-slot="ctr"><div style="font-size:9.5px; color:var(--color-neutral-600);">CTR</div><div style="font-size:12px; font-weight:500; font-variant-numeric:tabular-nums;"><%= cr.ctr %></div></div>',
      '                    <div><div style="font-size:9.5px; color:var(--color-neutral-600);">COST / BOOKING</div><div style="font-size:12px; font-weight:500; font-variant-numeric:tabular-nums;"><%= cr.cpb %></div></div>',
      '                    <div><div style="font-size:9.5px; color:var(--color-neutral-600);">HOOK</div><div style="font-size:12px; font-weight:500; font-variant-numeric:tabular-nums;"><%= cr.hookPct %></div></div>',
      '                    <div><div style="font-size:9.5px; color:var(--color-neutral-600);">HOLD</div><div style="font-size:12px; font-weight:500; font-variant-numeric:tabular-nums;"><%= cr.holdPct %></div></div>',
    ].join('\n'),
    why: 'cost per booking, hook and hold complete the funnel the card describes',
  },
  {
    screen: 'creatives',
    find: '>WINNING SCORE<',
    replace: '>BEST OVERALL<',
    relabel: true,
    valueFrom: 'cr.winning',
    why: 'the bar finally shows the thing the screen is opened to ask: how well is this creative doing its job',
  },
  /* The score's confidence, the one-line read, and total spend — the three
     things that make a number on a bar interpretable. Anchored on the bar's own
     closing tags, rewritten with a marker so the pattern cannot match twice. */
  {
    screen: 'creatives',
    find: "<span style=\"font-size:11px; font-weight:500; color:var(--color-accent-300); font-variant-numeric:tabular-nums;\"><%= cr.winning %></span>",
    replace: [
      '<span data-li-slot="score" style="font-size:11px; font-weight:500; color:var(--color-accent-300); font-variant-numeric:tabular-nums;"><%= cr.bestScore %></span>',
      '                    <span style="font-size:9.5px; color:<%= cr.confidenceColor %>;" title="Sample size decides how far a score is trusted. A creative with few leads is pulled toward the average of its funnel stage rather than being allowed to win on a handful of events."><%= cr.confidence %></span>',
    ].join('\n'),
    why: 'a score with no confidence beside it invites a decision the sample cannot support',
  },
  {
    screen: 'creatives',
    find: '<div style="font-size:10.5px; color:var(--color-neutral-500); margin-top:2px;">Hook: <%= cr.hook %> · <%= cr.platform %></div>',
    replace: [
      '<div style="font-size:10.5px; color:var(--color-neutral-500); margin-top:2px;" title="<%= cr.deliveryWhy %>"><%= cr.headline %></div>',
      '                  <div style="font-size:10px; color:var(--color-neutral-600); margin-top:2px;"><%= cr.hook %> · <%= cr.platform %> · <%= cr.spendTotal %> spent</div>',
    ].join('\n'),
    why: 'the line under the title is where a reader looks for why this creative ranks where it does',
  },
  /* Best at each stage, above the grid. A media buyer plans a week around
     "which is my best BOFU creative" as much as around the overall winner. */
  {
    screen: 'creatives',
    find: '          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">',
    replace: [
      '          <% if ((typeof creativeCensus !== "undefined") && creativeCensus && creativeCensus.length) { %>',
      '          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:14px; background:var(--color-surface); border:1px solid var(--color-neutral-900); border-radius:11px; padding:10px 14px; margin-bottom:12px; font-size:11.5px;">',
      '            <span style="color:var(--color-neutral-400); font-weight:500;"><%= creativeCensus.reduce(function (t, c) { return t + Number(c.count); }, 0) %> creatives analysed</span>',
      '            <% creativeCensus.forEach(function (c) { %>',
      '              <span style="color:<%= c.color %>;"><%= c.marker %> <%= c.count %> <%= c.label %></span>',
      '            <% }); %>',
      '          </div>',
      '          <% } %>',
      '          <% if ((typeof creativeNotes !== "undefined") && creativeNotes && creativeNotes.length) { %>',
      '          <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px;">',
      '            <% creativeNotes.forEach(function (n) { %>',
      '              <div style="flex:1 1 240px; background:var(--color-surface); border:1px solid var(--color-neutral-900); border-radius:10px; padding:9px 12px;">',
      '                <div style="font-size:9.5px; color:var(--color-neutral-600); text-transform:uppercase; letter-spacing:.04em;"><%= n.heading %></div>',
      '                <div style="font-size:11px; color:var(--color-neutral-300); margin-top:3px; line-height:1.45;"><%= n.text %></div>',
      '              </div>',
      '            <% }); %>',
      '          </div>',
      '          <% } %>',
      '          <% if ((typeof bestByStage !== "undefined") && bestByStage && bestByStage.length > 1) { %>',
      '          <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;">',
      '            <% bestByStage.forEach(function (b) { %>',
      '              <div class="hv-3" data-action="<%= b.go %>" style="display:flex; align-items:center; gap:7px; background:var(--color-surface); border:1px solid var(--color-neutral-900); border-radius:9px; padding:6px 11px; cursor:pointer; font-size:11px;">',
      '                <span><%= b.marker %></span>',
      '                <span style="color:var(--color-neutral-500);">Best <%= b.label %></span>',
      '                <span style="color:var(--color-neutral-200); font-weight:500;"><%= b.title %></span>',
      '                <span style="color:var(--color-accent-300); font-variant-numeric:tabular-nums;"><%= b.score %></span>',
      '              </div>',
      '            <% }); %>',
      '          </div>',
      '          <% } %>',
      '          <div data-li-slot="grid" style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">',
    ].join('\n'),
    why: 'the best creative at each funnel stage is a different question from the best overall, and both are asked',
  },
  /* The screen carried two scores and defined neither. A number on a badge that
     the reader cannot interpret is worse than no badge: it gets quoted and then
     acted on. So the heading line names what is on the cards, each badge
     carries its own definition as a tooltip, and the fatigue badge says its
     band in words next to the number — "50 · Act soon" needs no legend at all.

     The `title` attribute is not decoration here. It is the only place on a
     card-sized surface where a definition fits, and the design draws no room
     for one. */
  {
    screen: 'creatives',
    find: '>24 active creatives · sorted by revenue<',
    replace: '><%= creativeSummary %><',
    why: 'the line was fixed at 24 creatives sorted by revenue whatever was on screen and however it was ranked',
  },
  {
    screen: 'creatives',
    find: 'Fatigue <%= cr.fatigue %></span>',
    replace: 'Fatigue <%= cr.fatigue %> · <%= cr.fatigueBand %></span>',
    why: 'the score alone is the thing readers could not interpret; the band names it in words',
  },
  {
    screen: 'creatives',
    find: 'background:<%= cr.fatigueBg %>; color:<%= cr.fatigueColor %>;">Fatigue',
    replace: 'background:<%= cr.fatigueBg %>; color:<%= cr.fatigueColor %>; cursor:help;" title="<%= cr.fatigueWhy %>">Fatigue',
    pairedWith: 'Fatigue <%= cr.fatigue %></span>',
    why: 'what the score reads, over what window, against what — there is nowhere else on the card for it',
  },
  /* The leaderboard's position. The design draws no rank column — it draws one
     card grid — so the number rides in the corner of the card it belongs to,
     and renders only in the view that has positions to show. */
  /* Anchored on the format badge's opening tag, which the replacement rewrites
     with a `data-li-slot` marker so the pattern cannot match a second time.
     This binding *adds* markup rather than swapping it, and an add that still
     matches its own output stacks another copy on every rebind. */
  {
    screen: 'creatives',
    find: '<span style="position:absolute; top:8px; left:8px; font-size:10px;',
    replace: [
      '<% if (cr.rank) { %><span style="position:absolute; bottom:8px; left:8px; font-size:11px; font-weight:600; border-radius:5px; padding:2px 8px; background:rgba(20,22,31,.82); color:var(--color-accent-300); font-variant-numeric:tabular-nums;">#<%= cr.rank %></span><% } %>',
      '                  <span data-li-slot="format" style="position:absolute; top:8px; left:8px; font-size:10px;',
    ].join('\n'),
    why: 'the leaderboard needs to show position, and the design gives it no column to show it in',
  },
  {
    screen: 'creatives',
    find: 'color:var(--color-neutral-300);"><%= cr.dur %></span>',
    replace: 'color:var(--color-neutral-300); cursor:help;" title="<%= cr.durWhy %>"><%= cr.dur %></span>',
    why: 'the funnel badge needs to say why a top-of-funnel creative booking nothing is not underperforming',
  },
  /* The verdict. Fatigue tells a reader something is wrong and leaves them to
     work out what to do; this is the other half. It goes below the hold-rate
     bar because it is the line the card is read for — see lib/creative-verdict.js
     for how it is decided and why cost is weighed against the set's median. */
  {
    screen: 'creatives',
    find: '<%= cr.winning %></span>\n                  </div>\n                </div>',
    replace: [
      '<%= cr.winning %></span>',
      '                  </div>',
      '                  <div style="display:flex; align-items:flex-start; gap:8px; margin-top:10px; padding-top:9px; border-top:1px solid var(--color-neutral-900);" title="<%= cr.verdictWhy %>">',
      '                    <span style="flex:none; font-size:10px; font-weight:500; border-radius:5px; padding:3px 8px; background:<%= cr.verdictBg %>; color:<%= cr.verdictColor %>;"><%= cr.verdict %></span>',
      '                    <span style="font-size:10.5px; color:var(--color-neutral-500); line-height:1.35;"><%= cr.verdictInstruction %> — <%= cr.verdictBecause %></span>',
      '                  </div>',
      '                  <div style="display:flex; align-items:center; gap:10px; margin-top:7px; font-size:10px;">',
      '                    <span style="color:<%= cr.trendColor %>;" title="<%= cr.trendWhy %>"><%= cr.trend %></span>',
      '                    <span style="color:var(--color-neutral-600);"><%= cr.lifecycle %></span>',
      '                  </div>',
      '                </div>',
    ].join('\n'),
    why: 'a score with no instruction leaves the reader to decide what to do about it, which is the half that was missing',
  },
  /* The segmented control the design draws as three inert spans — no onClick,
     so nothing for the converter to preserve. Bound as one block because the
     three are one control: binding them singly would leave the strip half
     wired if a later re-run matched only some of them. */
  {
    screen: 'creatives',
    find: [
      '<span style="padding:5px 12px; background:var(--color-accent-900); color:var(--color-accent-300);">Gallery</span>',
      '              <span class="hv-3" style="padding:5px 12px; color:var(--color-neutral-500); cursor:pointer; border-left:1px solid var(--color-neutral-900);">Leaderboard</span>',
      '              <span class="hv-3" style="padding:5px 12px; color:var(--color-neutral-500); cursor:pointer; border-left:1px solid var(--color-neutral-900);">Timeline</span>',
    ].join('\n'),
    replace: [
      '<% (viewTabs || []).forEach(function (tab, i) { %>',
      '                <span class="hv-3" data-action="<%= tab.go %>" title="<%= tab.title %>" style="padding:5px 12px; cursor:pointer; background:<%= tab.bg %>; color:<%= tab.color %>; <% if (i) { %>border-left:1px solid var(--color-neutral-900);<% } %>"><%= tab.label %></span>',
      '              <% }); %>',
    ].join('\n'),
    why: 'the design draws the three views and wires none of them; each re-ranks the same cards',
  },
  /* What the screen judges by.
   *
   * A resort selling rooms is not judged the way a lead-gen account is, and
   * this account buys against *qualified* lead CPL rather than the
   * platform-reported kind — so the measure is a choice, and the choice needs
   * somewhere to live. The design draws one ranking control and no goal
   * control, so this adds a sibling to it, styled the same and enhanced by the
   * same code (`enhanceSort('li-goal-data', 'Judge by:')`).
   *
   * Anchored on the sort control's own opening tag, which the replacement
   * rewrites with a marker attribute so the pattern cannot match twice — this
   * binding adds markup, and an add that still matches its own output stacks
   * another copy on every rebind. */
  {
    screen: 'creatives',
    find: '<div class="hv-3" style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--color-neutral-500); border:1px solid var(--color-neutral-800); border-radius:7px; padding:5px 11px; cursor:pointer;" data-action="<%= sortNext %>">Sort:',
    replace: [
      '<div class="hv-3" data-li-slot="goal" style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--color-neutral-500); border:1px solid var(--color-neutral-800); border-radius:7px; padding:5px 11px; cursor:pointer;" title="What this screen judges a creative on. Different businesses buy against different measures.">Judge by: <%= goalLabel %><i class="ph ph-caret-down" style="font-size:11px;"></i></div>',
      '            <div class="hv-3" data-li-slot="sort" style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--color-neutral-500); border:1px solid var(--color-neutral-800); border-radius:7px; padding:5px 11px; cursor:pointer;" data-action="<%= sortNext %>">Sort:',
    ].join('\n'),
    why: 'the measure a creative is judged on is a property of the business, and the design draws no control for it',
  },
  /* The goal control shipped without a `data-action`, and the enhancer finds
     its controls among the elements that carry one — so the caret opened
     nothing at all. It also had no fallback for a reader without JavaScript,
     which the sort control has had since the day it was wired. Both are the
     same attribute. */
  {
    screen: 'creatives',
    find: '<div class="hv-3" data-li-slot="goal" style=',
    replace: '<div class="hv-3" data-li-slot="goal" data-action="<%= goalNext %>" style=',
    why: 'without it the goal control is unreachable by the menu enhancer and dead without JavaScript',
  },
  /* Said out loud when a goal has no source behind it. An empty column under a
     control that appears to work reads as an account that earned nothing, which
     is the failure this screen has had to undo more than once. */
  {
    screen: 'creatives',
    find: '<span><%= verdictLegend %></span>',
    replace: [
      '<span data-li-slot="verdict-legend"><%= verdictLegend %></span>',
      '            <% if (typeof goalNote !== \'undefined\' && goalNote) { %><span style="color:#ffcf85;"><%= goalNote %></span><% } %>',
    ].join('\n'),
    why: 'a goal nobody has connected a source for must say so rather than showing an empty column',
  },
  /* What the two scores on the cards mean, on the page rather than in a
     document nobody opens. Injected between the header row and the card grid,
     which is the only gap the design leaves.
   *
   * The find is anchored on the sort control's caret rather than on the bare
   * `</div>` that closes the header row, and that is not fussiness: this is the
   * one binding whose replacement *re-emits its own closing tags*, so anchoring
   * it on those tags would match again on the next run and stack a second
   * legend under the first. The caret is consumed into the middle of the
   * replacement, where the pattern can no longer find it. */
  {
    screen: 'creatives',
    find: '</i></div>\n          </div>\n          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">',
    replace: [
      '</i></div>',
      '          </div>',
      '          <div style="display:flex; flex-wrap:wrap; gap:6px 18px; margin:-4px 0 14px; font-size:10.5px; color:var(--color-neutral-600); line-height:1.5;">',
      '            <span><%= fatigueLegend %></span>',
      '            <span><%= verdictLegend %></span>',
      '          </div>',
      '          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">',
    ].join('\n'),
    why: 'both scores are this product\'s own, not Meta\'s, and a score with no definition beside it is a number that gets acted on anyway',
  },
  /* The sort control was drawn with a cursor and no behaviour — no handler, no
     parameter, nothing behind it — so it has never sorted anything. Giving it a
     `data-action` is a conversion concern for the same reason the Sankey labels
     were: the design declares the control, and binding it here means a
     converter re-run reproduces the wiring rather than dropping it. */
  {
    screen: 'creatives',
    find: 'cursor:pointer;">Sort: Revenue<i class="ph ph-caret-down"',
    replace: 'cursor:pointer;" data-action="<%= sortNext %>">Sort: <%= sortLabel %><i class="ph ph-caret-down"',
    why: 'the design draws the control but wires nothing to it; revenue is not a column this screen can fill',
  },
  /* The executive summary, above everything else on the screen: how many
     creatives were analysed, what each was recommended for, and the two or
     three sentences a reader wants before reading any card. Every figure is a
     tally of the recommendations below it, so the summary cannot disagree with
     the screen it summarises.

     Anchored on the best-by-stage strip's own opening, rewritten with a marker
     so this add cannot match its own output on a later run. */
  {
    screen: 'creatives',
    find: '          <% if ((typeof bestByStage !== "undefined") && bestByStage && bestByStage.length > 1) { %>',
    replace: [
      '          <% if ((typeof creativeCensus !== "undefined") && creativeCensus && creativeCensus.length) { %>',
      '          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:14px; background:var(--color-surface); border:1px solid var(--color-neutral-900); border-radius:11px; padding:10px 14px; margin-bottom:12px; font-size:11.5px;">',
      '            <span style="color:var(--color-neutral-400); font-weight:500;"><%= creativeCensus.reduce(function (t, c) { return t + Number(c.count); }, 0) %> creatives analysed</span>',
      '            <% creativeCensus.forEach(function (c) { %>',
      '              <span style="color:<%= c.color %>;"><%= c.marker %> <%= c.count %> <%= c.label %></span>',
      '            <% }); %>',
      '          </div>',
      '          <% } %>',
      '          <% if ((typeof creativeNotes !== "undefined") && creativeNotes && creativeNotes.length) { %>',
      '          <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px;">',
      '            <% creativeNotes.forEach(function (n) { %>',
      '              <div style="flex:1 1 240px; background:var(--color-surface); border:1px solid var(--color-neutral-900); border-radius:10px; padding:9px 12px;">',
      '                <div style="font-size:9.5px; color:var(--color-neutral-600); text-transform:uppercase; letter-spacing:.04em;"><%= n.heading %></div>',
      '                <div style="font-size:11px; color:var(--color-neutral-300); margin-top:3px; line-height:1.45;"><%= n.text %></div>',
      '              </div>',
      '            <% }); %>',
      '          </div>',
      '          <% } %>',
      '          <% if (bestByStage && bestByStage.length > 1) { %>',
    ].join('\n'),
    why: 'a screen of cards with no summary makes the reader do the counting',
  },
  /* Which way the creative is going, and where it is in its life — beside the
     recommendation, because the recommendation was partly decided by them. */
  {
    screen: 'creatives',
    find: '<span style="font-size:10.5px; color:var(--color-neutral-500); line-height:1.35;"><%= cr.verdictInstruction %> — <%= cr.verdictBecause %></span>',
    replace: [
      '<span data-li-slot="why" style="font-size:10.5px; color:var(--color-neutral-500); line-height:1.35;"><%= cr.verdictInstruction %> — <%= cr.verdictBecause %></span>',
      '                  </div>',
      '                  <div style="display:flex; align-items:center; gap:10px; margin-top:7px; font-size:10px;">',
      '                    <span style="color:<%= cr.trendColor %>; cursor:help;" title="<%= cr.trendWhy %>"><%= cr.trend %></span>',
      '                    <span style="color:var(--color-neutral-600);"><%= cr.lifecycle %></span>',
    ].join('\n'),
    why: 'a recommendation partly decided by trend and fatigue should show both',
  },
  /* **The creative, playing.**
   *
   * The design draws a 180-pixel header with the still behind it and a play
   * icon in the middle that has never done anything. Most of this account is
   * video, and a still is what an ad looks like paused — the hook, the pacing
   * and the cut are the creative, and none of them survive a freeze frame.
   *
   * So where there is a video the header becomes a real player, with the still
   * as its poster so the panel looks identical until it is played. Where there
   * is not — an image ad — the design's own markup is kept exactly. */
  {
    screen: 'overlay-creative-detail',
    find: [
      '<div style="height:180px; background:<%= selCr.grad %>; display:grid; place-items:center; position:relative;">',
      '              <div style="width:46px; height:46px; border-radius:99px; background:rgba(20,22,31,.7); display:grid; place-items:center;"><i class="ph-fill ph-play" style="font-size:20px; color:var(--color-accent-200);"></i></div>',
    ].join('\n'),
    replace: [
      '<div style="height:<%= selCr.video ? 260 : 180 %>px; background:<%= selCr.grad %>; display:grid; place-items:center; position:relative;">',
      '              <% if (selCr.video) { %>',
      '                <video src="<%= selCr.video %>" poster="<%= selCr.poster %>" controls playsinline preload="metadata" style="width:100%; height:100%; object-fit:contain; background:#000;"></video>',
      '              <% } else { %>',
      '                <div style="width:46px; height:46px; border-radius:99px; background:rgba(20,22,31,.7); display:grid; place-items:center;"><i class="ph-fill ph-image" style="font-size:20px; color:var(--color-accent-200);"></i></div>',
      '              <% } %>',
    ].join('\n'),
    why: 'a still is what an ad looks like paused, and most of this account is video',
  },
  /* The card says whether there is anything to play, so a reader knows the
     panel is worth opening. */
  {
    screen: 'creatives',
    find: '<div style="width:38px; height:38px; border-radius:99px; background:rgba(20,22,31,.7); display:grid; place-items:center;"><i class="<%= cr.icon %>"',
    replace: '<div style="width:38px; height:38px; border-radius:99px; background:rgba(20,22,31,<%= cr.video ? .78 : .55 %>); display:grid; place-items:center;" title="<%= cr.video ? "Open to watch this creative" : "Open for the full-size still" %>"><i class="<%= cr.video ? "ph-fill ph-play" : cr.icon %>"',
    why: 'the play badge should mean there is something to play',
  },
  {
    screen: 'attribution',
    find: '>₹18.9L<',
    replace: '><%= attrSankeyMeta %><',
    why: 'Meta node — must follow the workspace attribution model',
  },
  {
    screen: 'attribution',
    find: '>₹52.3L<',
    replace: '><%= attrSankeyTotal %><',
    why: 'booking node — total credited revenue under the model in force',
  },
];

function bindLiterals(html, screen, { onBind } = {}) {
  let out = html;
  for (const binding of LITERAL_BINDINGS.filter((b) => b.screen === screen)) {
    const occurrences = out.split(binding.find).length - 1;
    if (occurrences === 0) continue;
    if (occurrences > 1) {
      throw new Error(`${screen}: "${binding.find}" appears ${occurrences} times — a binding must be unambiguous`);
    }
    out = out.replace(binding.find, binding.replace);
    if (onBind) onBind(binding);
  }
  return out;
}

module.exports = { LITERAL_BINDINGS, bindLiterals };
