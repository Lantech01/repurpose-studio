# Agent verification rules

- Run `npm run fixtures:media` once before tests that consume local media fixtures.
- Use port 3001 for development and Playwright in this worktree. Do not disturb the project server on port 3000.
- Never use the preview proxy for export. Export must read the authoritative source media path.
- Put `// @vitest-environment node` at the top of every `tests/server/*.test.ts` file and every other Node-only integration test.
- Run `npm run verify` before declaring work complete.
