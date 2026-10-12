# Checking if we are taking the lowest

Script: `src/pricing/check_lowest.ts`
Example I/O: https://docs.google.com/spreadsheets/d/1dYNiPwoyw-NZOpapKMlIQ4ygu3iuSR9YQyX76bNv9OI/edit?gid=0#gid=0

## Objective

- Knowing if we are taking the lowest
- If we are not taking the lowest
  - Which seller is taking the lowest price
  - How many sellers are taking lower prices
  - Knowing the price difference from the lowest page

## Job

- Comparing the prices of our pages with the lowest prices
- Checking who is taking the lowest
- Include only pages whose shipping fees are within +20% of our pages
  - If we charge $100 for shipping fees, it only includes pages whose shipping fees are up to $120
  - Only the upper limit applies: cheaper or free shipping is included. Pages above the limit (or with unknown shipping) go to Excluded Pages

## Caution

- Compare only with Japanese sellers, which you can identify by seeing "Located in Japan" on each item
- Compare only prices; do not include shipping fees

## Sheets

- Input: eBay Item Id, Brand, Identity, CCURL (Our Shipping fee optional; taken from our listing when missing)
- Output: one row per our item — our price/shipping, Lowest Rank, lowest page price/diff/shipping/seller/URL, lower page URLs, exclusion page URLs
- Excluded Pages: one row per cheaper page dropped by the shipping rule — page price/shipping, reason, Identity,
  our shipping, shipping diff, our price, price diff (ours - theirs), our page URL,
  price diff - shipping diff (our total minus theirs; positive means their page is cheaper in total)
- Output Summary: formulas over Output and Excluded Pages. Its competitor table's "Total listings" column looks each seller up in Seller Listings
- Seller Listings: each competitor's active eBay Motors listing count, filled by `src/pricing/seller_listing_counts.ts`

## Run

```bash
npx tsx src/pricing/check_lowest.ts input.tsv > output.json
npx tsx src/pricing/seller_listing_counts.ts japan_store spice-japan
```
