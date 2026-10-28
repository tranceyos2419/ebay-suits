# AGENTS.md

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

- Source and scripting files (`.ts`, etc.) live in a category folder under `src/`, never directly in `src/`:
  - `src/lib/` — shared modules imported by scripts (API clients, CSV, XML, utilities)
  - `src/auth/` — eBay credentials and sign-in
  - `src/listings/` — reading and revising our listings and shipping policies
  - `src/pricing/` — price lookups and competitor/price-tracker comparisons
  - `src/sales/` — orders, revenue and payouts
  - `src/returns/` — returns and refunds
  - `src/messages/` — buyer messages
  - `src/shipping/` — Ship&Co orders and shipping labels
  - `src/maintenance/` — housekeeping for this project (e.g. report cleanup)
  - `src/legacy/` — the previous Trading API and Post-Order API versions of scripts, mirroring the folders above. They are kept for reference and must not be used for new work.
- When creating a `.ts` file, put it in the matching category folder. If no folder fits, create a new, clearly named category folder under `src/` and put the file there.
- Project configuration (`package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`) stays at the project root.
- Local secrets (for example, `credentials.json`) stay at the project root, must have permissions set to `600`, and must be ignored by Git. Never move them into `src/` or commit them.

When adding new files, place them in the category folder they belong to rather than the project root.

## Which eBay account

Before doing anything in this folder, make sure you know which eBay account the task applies to. If the user's message does not make it clear, ask which account to work on before proceeding.

Once the account is known, pass it to every script with `--account <name>` (`jdm-direct-motors` or `love-of-japan`). Scripts get their tokens from `src/auth/ebay_auth.ts`; do not export tokens into the shell. Check token expiry and OAuth scopes with `npx tsx src/auth/ebay_auth.ts status`. An OAuth sign-in (`src/auth/ebay_login.ts`) needs the user to sign in to eBay in their own browser, so ask them to run it.

## Interacting with eBay

Default to using the eBay API for any interaction with eBay. Use another method, such as browser automation, only if the user specifies otherwise.

### Use eBay's Modernized APIs

All new work, including new scripts, new features, and any change to an existing script, must use eBay's Modernized APIs and never the Traditional ones:
- GraphQL at `https://graphqlapi.ebay.com/graphql` (`src/lib/graphql_api.ts`): the Listing API for reading and updating our listings, and the Return API for returns.
- Modern REST APIs: Fulfillment (orders), Message (buyer messages), Browse (other sellers' listings), Account, Negotiation, Finances, and Identity.
- Do not use the Trading API (XML), the Post-Order API, or Auth'n'Auth tokens in new code. The old Trading and Post-Order versions live in `src/legacy/` for reference only. Do not add to them or import them from outside `src/legacy/`.
- If something has no Modernized API equivalent yet, stop and tell the user before falling back to a Traditional API.
- eBay's GraphQL introspection is disabled. Look up exact types with eBay's schema search (`https://api.ebay.com/developer/mcp/v1/gqlmcp/search`) or the docs at `https://developer.ebay.com/develop/api/sell/<api>.md`.
