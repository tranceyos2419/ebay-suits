# CLAUDE.md

## Scripting language

Use TypeScript for all scripting files created in this project.

## Git workflow

Whenever changes are made in this folder, commit them and push to the `main` branch.
Remote: https://github.com/tranceyos2419/ebay-suits.git

## File organization

Keep files organized by category by default:
- Source/scripting files (`.ts`, etc.) live under `src/`.
- Project config (`package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `CLAUDE.md`) stays at the project root.
- Local secrets (e.g. `credentials.json`) stay at the project root, chmod 600, and gitignored — never move them into `src/` or commit them.

When adding new files, place them in the category folder they belong to rather than the project root.
