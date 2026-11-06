# CLAUDE.md

## Scripting language

Use TypeScript for all scripting files created in this project.

## Git workflow

Before starting work on this project, verify the Git remote repository configured as `origin` and fetch `origin/main`. If `origin/main` contains changes that are not present in the local `main` branch, pull and apply those changes locally before making project changes. Preserve existing local and uncommitted work; if the update cannot be applied safely, stop and report the conflict before proceeding.

Whenever changes are made in this folder, commit them and push to the `main` branch.
Remote: https://github.com/tranceyos2419/ebay-suits.git

## Instruction file synchronization

Keep `AGENTS.md` and `CLAUDE.md` synchronized. Whenever a project rule is added, changed, or removed in either file, make the equivalent change in the other file during the same task.

## File organization

Keep files organized by category by default:
- Source/scripting files (`.ts`, etc.) live in a category folder under `src/`, never directly in `src/`:
  - `src/lib/` — shared modules imported by scripts (API clients, CSV, XML, utilities)
  - `src/auth/` — eBay credentials and sign-in
  - `src/listings/` — reading and revising our listings and shipping policies
  - `src/pricing/` — price lookups and competitor/price-tracker comparisons
  - `src/sales/` — orders, revenue and payouts
  - `src/returns/` — returns and refunds
  - `src/cases/` — Item Not Received inquiries and eBay cases
  - `src/messages/` — buyer messages
  - `src/shipping/` — Ship&Co orders and shipping labels
  - `src/maintenance/` — housekeeping for this project (e.g. report cleanup)
  - `src/legacy/` — the previous Trading API / Post-Order API versions of scripts, mirroring the folders above; kept for reference, not for new work
- When creating a `.ts` file, put it in the matching category folder. If no folder fits, create a new, clearly named category folder under `src/` and put the file there.
- Project config (`package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `CLAUDE.md`) stays at the project root.
- Local secrets (e.g. `credentials.json`) stay at the project root, chmod 600, and gitignored — never move them into `src/` or commit them.

When adding new files, place them in the category folder they belong to rather than the project root.

## Which eBay account

Before doing anything in this folder, make sure you know which eBay account the task applies to. If the user's message doesn't make it clear, ask them which account to work on before proceeding.

Once the account is known, pass it to every script with `--account <name>` (`jdm-direct-motors` or `love-of-japan`). Scripts get their tokens from `src/auth/ebay_auth.ts`; don't export tokens into the shell. Check token expiry and OAuth scopes with `npx tsx src/auth/ebay_auth.ts status`. An OAuth sign-in (`src/auth/ebay_login.ts`) needs the user to sign in to eBay in their own browser, so ask them to run it.

On Claude Code on the web there is no `credentials.json`: the `ebay-suits` cloud environment supplies its whole contents (eBay keys and the Ship&Co token) as the environment variable `EBAY_CREDENTIALS_JSON`, plus `NODE_USE_ENV_PROXY=1` so Node's fetch goes through the web sandbox's proxy, and the scripts read them automatically. These are the live production credentials, so treat a web session exactly like the local computer: dry-run first and confirm with the user before any change to a listing, order, return or buyer message. Never print, log or commit the values. Whenever `credentials.json` changes locally (a new sign-in, new scopes, a new Ship&Co token), the user runs `npm run web-env` on their computer, which copies the whole block to the clipboard, and pastes it over the environment's Environment variables box.

The Ship&Co API token is stored in `credentials.json` under `shipandco.apiToken` (so it also travels inside `EBAY_CREDENTIALS_JSON`); `src/lib/shipandco_api.ts` falls back to `SHIPANDCO_API_TOKEN` from the environment or `.env` only when that entry is missing.

## Interacting with eBay

Default to using the eBay API for any interaction with eBay. Use another method (e.g. browser automation) only if the user specifies otherwise.

### Use eBay's Modernized APIs

All new work — new scripts, new features, and any change to an existing script — must use eBay's Modernized APIs, never the Traditional ones:
- GraphQL at `https://graphqlapi.ebay.com/graphql` (`src/lib/graphql_api.ts`): Listing API for reading and updating our listings, Return API for returns, Order Inquiry API for Item Not Received inquiries.
- Modern REST APIs: Fulfillment (orders), Message (buyer messages), Browse (other sellers' listings), Account, Negotiation, Finances, Identity.
- Do not use the Trading API (XML), the Post-Order API, or Auth'n'Auth tokens in new code. The old Trading/Post-Order versions live in `src/legacy/` for reference only; don't add to them or import them from outside `src/legacy/`.
- If something truly has no Modernized API equivalent yet, stop and tell the user before falling back to a Traditional API.
- eBay's GraphQL introspection is disabled; look up exact types with eBay's schema search (`https://api.ebay.com/developer/mcp/v1/gqlmcp/search`) or the docs at `https://developer.ebay.com/develop/api/sell/<api>.md`.
