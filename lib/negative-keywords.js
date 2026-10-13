/* Negative keyword suggestions, per campaign: search terms UNRELATED to it.
 *
 * The one criterion is relevance — whether a term spent or converted plays no
 * part. What a campaign is about is read off its own keywords, so "unrelated"
 * is a fact about the account rather than a guess:
 *
 *   exact   a search term that shares no meaningful word with any of the
 *           campaign's keywords.
 *   phrase  a word found in two or more of those unrelated terms and in none of
 *           the campaign's related ones — the unrelated vocabulary itself, so
 *           blocking it blocks nothing the campaign has matched usefully.
 *
 * Words are compared after dropping filler ("the", "near", "best") and a plural
 * s, so "resorts near me" is related to a keyword "resort". A campaign with no
 * keywords in the account list cannot be judged and is skipped, not guessed.
 * Terms Google already reports as added or excluded are left out.
 *
 * Campaign level, because a term unrelated to one campaign can be another's
 * whole point. Spend is carried only to rank the list.
 */

const FILLER = new Set([
  'the', 'and', 'for', 'with', 'near', 'from', 'best', 'top', 'good', 'nearby',
  'what', 'where', 'how', 'which', 'are', 'can', 'you', 'your', 'our', 'this', 'that',
]);

const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

const tokens = (text) => String(text || '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 3 && !FILLER.has(w))
  .map(stem);

/* `rows` are search-term day rows: { term, termStatus, campaignId, spend,
   clicks, impressions, leads }. `keywords` is the account's keyword list:
   { keyword, campaignId }. Spend is in paise. */
function suggest({ rows = [], keywords = [], campaignName = () => null } = {}) {
  const vocab = new Map();
  for (const k of keywords) {
    if (!k.campaignId || !k.keyword) continue;
    const id = String(k.campaignId);
    if (!vocab.has(id)) vocab.set(id, new Set());
    for (const w of tokens(k.keyword)) vocab.get(id).add(w);
  }

  const byCampaign = new Map();
  for (const r of rows) {
    if (!r.term || !r.campaignId) continue;
    const id = String(r.campaignId);
    if (!byCampaign.has(id)) byCampaign.set(id, new Map());
    const terms = byCampaign.get(id);
    const key = String(r.term).toLowerCase().trim();
    const acc = terms.get(key) || { term: r.term, status: null, spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    acc.spend += r.spend || 0;
    acc.clicks += r.clicks || 0;
    acc.impressions += r.impressions || 0;
    acc.conversions += r.leads || 0;
    if (r.termStatus) acc.status = String(r.termStatus).toUpperCase();
    terms.set(key, acc);
  }

  const campaigns = [];
  const unjudged = [];
  for (const [id, terms] of byCampaign) {
    const own = vocab.get(id);
    if (!own || !own.size) { unjudged.push({ campaignId: id, campaign: campaignName(id) || `Unnamed campaign (${id})` }); continue; }

    const all = [...terms.values()].filter((t) => !/ADDED|EXCLUDED/.test(t.status || ''));
    const related = (t) => tokens(t.term).some((w) => own.has(w));
    const unrelated = all.filter((t) => tokens(t.term).length && !related(t));

    const relatedWords = new Set();
    for (const t of [...terms.values()]) if (related(t)) for (const w of tokens(t.term)) relatedWords.add(w);

    const exact = unrelated.map((t) => ({
      ...t, keyword: t.term, match: 'exact', reason: 'shares no word with this campaign\'s keywords',
    }));

    const byWord = new Map();
    for (const t of unrelated) {
      for (const w of new Set(tokens(t.term))) {
        if (relatedWords.has(w)) continue;
        const acc = byWord.get(w) || { keyword: w, match: 'phrase', terms: 0, spend: 0, clicks: 0, impressions: 0, conversions: 0 };
        acc.terms += 1;
        acc.spend += t.spend;
        acc.clicks += t.clicks;
        acc.impressions += t.impressions;
        acc.conversions += t.conversions;
        byWord.set(w, acc);
      }
    }
    const phrase = [...byWord.values()]
      .filter((w) => w.terms >= 2)
      .map((w) => ({ ...w, reason: `in ${w.terms} unrelated terms, in no related one` }));

    const suggestions = [...phrase, ...exact].sort((a, b) => b.spend - a.spend || b.impressions - a.impressions);
    if (!suggestions.length) continue;
    campaigns.push({
      campaignId: id,
      campaign: campaignName(id) || `Unnamed campaign (${id})`,
      suggestions,
      spend: unrelated.reduce((s, t) => s + t.spend, 0),
    });
  }
  campaigns.sort((a, b) => b.spend - a.spend);
  Object.defineProperty(campaigns, 'unjudged', { value: unjudged, enumerable: false });
  return campaigns;
}

/* Google Ads Editor's import shape: an empty Ad group makes it a campaign-level
   negative, and Criterion Type carries the match type. */
function toCsv(campaigns) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [['Campaign', 'Ad group', 'Keyword', 'Criterion Type'].join(',')];
  for (const c of campaigns) {
    for (const s of c.suggestions) {
      lines.push([c.campaign, '', s.keyword, s.match === 'exact' ? 'Negative exact' : 'Negative phrase'].map(cell).join(','));
    }
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { suggest, toCsv, tokens };
