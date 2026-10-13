/* Negative keyword suggestions, per campaign, from the account's own search terms.
 *
 * Two kinds, both read off what Google reported for the selected range — none
 * of it is a guess about intent:
 *
 *   exact   a search term that spent and converted nobody in that campaign.
 *           Negated exactly, so only that query is blocked.
 *   phrase  a word found in two or more of those wasted terms, never in a
 *           converting term of the campaign and never in one of its own
 *           keywords. Negated as a phrase, so every query carrying it is blocked
 *           — which is why the bar for it is higher.
 *
 * Campaign level rather than account level because a word that wastes money in
 * one campaign can be the whole point of another.
 *
 * Skipped: terms Google already reports as added or excluded (`termStatus`), and
 * anything that would block one of the campaign's own keywords — a negative
 * that switches off the keyword it sits beside is the costliest mistake this
 * list could make.
 */

const MIN_WORD_LENGTH = 3;

const tokens = (text) => String(text || '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= MIN_WORD_LENGTH);

const normal = (text) => tokens(text).join(' ');

/* `rows` are search-term day rows: { term, termStatus, campaignId, spend,
   clicks, impressions, leads }. `keywords` is the account's keyword list:
   { keyword, campaignId, status }. Spend is in paise. */
function suggest({ rows = [], keywords = [], campaignName = () => null, minSpend = 0 } = {}) {
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

  const ownWords = new Map();
  const ownPhrases = new Map();
  for (const k of keywords) {
    if (!k.campaignId || !k.keyword) continue;
    const id = String(k.campaignId);
    if (!ownWords.has(id)) { ownWords.set(id, new Set()); ownPhrases.set(id, new Set()); }
    for (const w of tokens(k.keyword)) ownWords.get(id).add(w);
    ownPhrases.get(id).add(normal(k.keyword));
  }

  const campaigns = [];
  for (const [id, terms] of byCampaign) {
    const words = ownWords.get(id) || new Set();
    const phrases = ownPhrases.get(id) || new Set();
    const all = [...terms.values()];
    const wasted = all.filter((t) => t.spend > 0 && !t.conversions && !/ADDED|EXCLUDED/.test(t.status || ''));

    const converting = new Set();
    for (const t of all) if (t.conversions > 0) for (const w of tokens(t.term)) converting.add(w);

    const exact = wasted
      .filter((t) => t.spend >= minSpend && !phrases.has(normal(t.term)))
      .map((t) => ({ ...t, keyword: t.term, match: 'exact', reason: `${t.clicks} click(s), no conversion` }));

    const byWord = new Map();
    for (const t of wasted) {
      for (const w of new Set(tokens(t.term))) {
        if (words.has(w) || converting.has(w)) continue;
        const acc = byWord.get(w) || { keyword: w, match: 'phrase', terms: 0, spend: 0, clicks: 0, impressions: 0, conversions: 0 };
        acc.terms += 1;
        acc.spend += t.spend;
        acc.clicks += t.clicks;
        acc.impressions += t.impressions;
        byWord.set(w, acc);
      }
    }
    const phrase = [...byWord.values()]
      .filter((w) => w.terms >= 2 && w.spend >= minSpend)
      .map((w) => ({ ...w, reason: `in ${w.terms} non-converting terms, never in a converting one or a keyword` }));

    const suggestions = [...phrase, ...exact].sort((a, b) => b.spend - a.spend);
    if (!suggestions.length) continue;
    campaigns.push({
      campaignId: id,
      campaign: campaignName(id) || `Unnamed campaign (${id})`,
      suggestions,
      spend: wasted.filter((t) => t.spend >= minSpend).reduce((s, t) => s + t.spend, 0),
    });
  }
  return campaigns.sort((a, b) => b.spend - a.spend);
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
