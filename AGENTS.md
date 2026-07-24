# AGENTS.md

Instructions for AI agents working in `Devneya/app`.

## What this repo is

Primary Devneya web UI: sign-in, virtual API key, usage/subscription management.
Calls `api.devneya.com` (GoTrue + `devneya-api`). Not the archived playground canvas app.

## Before claiming done

Run all gates locally:

```bash
npm run lint && npm run typecheck && npm run test && npm run test:e2e
```

All must pass. Do not rely on manual browser review alone.

## Testing conventions

- **Unit/component**: Vitest + React Testing Library in `*.test.tsx` next to the component.
- **E2E**: Playwright in `tests/e2e/mock/` against MSW-backed preview build.
- Prefer `getByRole` / `getByLabelText`. Use `data-testid` only when no accessible name exists.
- MSW handlers live in `src/mocks/handlers/` — keep shapes aligned with `Devneya/control-plane/docs/openapi.yaml`.
- Reset mock state between tests via `resetMockSession()` / `setMockSubscribed()`.

## Mock credentials (MSW mode)

- Email: `demo@devneya.com`
- Password: `password123`

## Auth note

GoTrue is accessed via `@supabase/supabase-js` with `/auth/v1/` → `/auth/` URL rewrite in `src/supabase.ts` (same pattern as playground).

## Do not

- Deploy to production VM or change DNS without explicit operator approval.
- Commit secrets (`.env` is gitignored).
- Copy playground canvas/XYFlow complexity into this app without a deliberate scope change.
