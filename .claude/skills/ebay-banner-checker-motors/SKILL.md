---
name: ebay-banner-checker-motors
description: Checks whether eBay listings have a banner on their main photo and writes the result to a CSV. Input is a CSV with "eBay Item id" and "PURL" columns; output is the same rows plus a "with Banner" column containing "with Banner" or "no banner". Use this whenever the user hands over a CSV of eBay item ids / PURLs and asks to check, find, or flag banners (or "resetting banners and images"), or mentions ebay-banner-checker-motors, even if they don't say the word "skill".
---

# eBay banner checker (motors)

The user has listings whose main photo may carry a banner (e.g. a brand header
bar, store logo strip, watermark overlay). They give a CSV of item ids and want
each one classified so the banner images can be reset later. The output must be
trustworthy row by row, so every verdict comes from actually looking at the
photo, never from the title or guesswork.

## Input / output

Input CSV columns: `eBay Item id,PURL`

Output CSV (same rows, same order, new third column):

```
eBay Item id,PURL,with Banner
397435230804,https://www.ebay.com/itm/397435230804,with Banner
397435230561,https://www.ebay.com/itm/397435230561,no banner
```

The value is exactly `with Banner` or `no banner`. Save it next to the input
as `<input name> - Output.csv` (swap "Input" for "Output" if the name has it)
and tell the user the path. Never overwrite the input file.

## Workflow

1. **Know the account.** This project requires knowing which eBay account a
   task applies to (see CLAUDE.md). If the user names one, use it. The
   credentials file only has seller stores (`jdm-direct-motors`,
   `love-of-japan`), not the tranceyos login names, so if the user gives a
   tranceyos name, use the store whose listings these are: the script prints
   the seller of each item, so run it once and confirm every row shows the same
   seller. Say in your final message which store you used.
2. **Fetch the photos through the eBay API** (project default; no browser).
   From the project root:

   ```bash
   npx tsx src/listings/fetch_listing_images.ts --account <store> --out <scratchpad>/imgs "<input.csv>"
   ```

   It calls GetItem (read-only) per item, saves the main photo as
   `<out>/<itemId>_1.jpg` and prints `itemId  seller  ack  pictureCount  title`.
   Add `--all` only if the user asks to check every photo, not just the main one.
   If `credentials.json` says it has no "accounts" object, it is in the old
   layout: run `npx tsx src/auth/ebay_auth.ts status` and see the header of
   `src/auth/ebay_auth.ts` for the layout (back the file up before converting; never
   print token values).
3. **Look at each photo** with the Read tool (batch them in parallel) and decide.
4. **Write the output CSV** and report a short tally plus anything odd.

## What counts as a banner

Judge the main photo only. It is **with Banner** if anything is laid over or
around the product that is not the product photo itself:

- a header/footer bar or strip (brand bar such as "SUBARU GENUINE PARTS", part
  number bar, "Confidence in Motion" footer)
- a store/seller logo or watermark stamped on the image (e.g. "JDM DIRECT")
- promo text, "Image Coming Soon"/stock placeholder graphics, badges, frames

It is **no banner** if it is a plain product photo, even if the product itself
has printed labels, stickers or brand text on it (a box label or an emblem is
the product, not a banner). Products photographed on a plain or studio
background with no added graphics are fine.

If the call is genuinely borderline, pick the more conservative answer
(`with Banner`) so a flagged image gets a human look rather than slipping
through, and mention the item id in your summary.

## Edge cases

- **Item not found / ended / API error:** don't guess. Leave the cell as
  `not found` and list those ids in your summary.
- **No picture at all:** `no banner` is wrong (there is nothing to judge); use
  `not found` and flag it.
- **Placeholder "image coming soon" photo:** counts as with Banner, but call it
  out in the summary since there is no real product photo behind it.
- **Mixed sellers in one CSV:** the API accepts either store's token for a
  public read, so the answer doesn't change; still report the sellers seen.

## Final message

Give: output path, counts (`with Banner` / `no banner` / `not found`), the store
used, and the short list of items worth a second look. Keep it brief; the CSV
is the deliverable.
