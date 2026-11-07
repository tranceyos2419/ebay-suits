# Monthly: changing quantity of the eBay items based on the class in Value Checker

Runs on the 1st of every month (scheduled task). Account: **jdm-direct-motors**.
The user has approved applying these quantity changes automatically, without
asking for confirmation first.

- Value Checker: spreadsheet `15-lYOj48_8nAGdj_0tzrYTDkiRMVmjAZRWJ0wDZIyCM`, tab **Motors** (sheetId 57313459)
- eBay Item Id: column **O**
- Filter view **Achmad - Class A** → quantity **4**
- Filter view **Achmad - Class B** → quantity **2**

## Steps

0. In the repo, run `npm ci` if `node_modules` is missing, and check the token with
   `npx tsx src/auth/ebay_auth.ts status` (needs the sell.listing scope). If the
   token can't be refreshed, stop and tell the user to sign in again.
1. Read the filter view definitions with the Google Sheets connector
   (`get_spreadsheet`, fields `sheets.properties.title`, `sheets.properties.sheetId`,
   `sheets.filterViews`). The full response is too large to read inline and is saved
   to a file; extract just the Motors tab with jq into a scratch file:
   `jq '{sheets:[.sheets[]|select(.properties.title=="Motors")|{properties:{title:.properties.title,sheetId:.properties.sheetId},filterViews}]}' <saved file> > fv.json`
2. Find which columns the two Class views filter on (the `filterSpecs` entries that
   have `hiddenValues`; at the time of writing H, Q, R and BI). Fetch the item-id
   column O plus each of those columns with `get_values`, **one column range per call**
   (e.g. `Motors!H1:H<rowCount>`; a multi-range request is too large and drops the
   connector). Each result is saved to a file; keep the paths.
3. Dry run:
   ```
   npx tsx src/listings/class_quantity_update.ts --account jdm-direct-motors \
     --spreadsheet fv.json --values <H file> --values <O file> --values <Q:R file> --values <BI file> \
     --sheet Motors --id-column O --view "Achmad - Class A=4" --view "Achmad - Class B=2"
   ```
   Sanity-check the output: the script stops on its own if a view or column is
   missing or a view uses filter types it can't evaluate. If the dry run would change
   more than ~2,000 listings, or the row counts per view are wildly different from
   last month (~3,300 Class A / ~28,600 Class B in Nov 2026), stop and report
   instead of applying.
4. Apply: run the same command with `--apply`.
5. Report back: rows shown per view, how many listings were changed (old → new
   quantity counts per view), already correct, skipped, not active, and any
   failures with their eBay error. The per-item CSV is written under `reports/`
   (gitignored); attach or summarise it. Do not commit anything.
