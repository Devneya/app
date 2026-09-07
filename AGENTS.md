# AGENTS.md

Instructions for AI agents working in `Devneya/app`.

## What this repo is

Primary Devneya web UI: sign-in, virtual API key, usage/subscription management.
Calls `api.devneya.com` (GoTrue + `devneya-api`). Not the archived playground canvas app.

The hard architecture and implementation rules in
[control-plane/AGENTS.md](https://github.com/Devneya/control-plane/blob/main/AGENTS.md)
apply to this repository's UI and integrations: KISS, DRY, YAGNI, least surprise,
user responsibility, no speculative fail-closed gates, direct checks of every
callee's errors and required outputs, complete error/output propagation with
safe diagnostics, and verified synchronous operations. Read that section before
implementation or review. Remove confirmed over-engineering; retain required
authorization, integrity, and effect verification. Failed or unverified actions
stop dependent work and reach the caller without becoming success.

Apply the same rules to tests and helpers: cover documented behavior and
demonstrated defects, reuse fixtures, and avoid speculative cases or machinery.

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
- MSW handlers live in `src/mocks/handlers/` — keep shapes aligned with `Devneya/api/openapi.yaml`.
- Reset mock state between tests via `resetMockSession()` / `setMockSubscribed()`.

### Coverage TODO (2026-08-07)

Increase tests for recent auth/inference work — tracked in
`control-plane/docs/open-items.md`:

- `AuthConfirmPage` (success / error hash states)
- Sub-cent usage formatting (`formatUsd` must not round tiny spend to `$0.00`)
- Signup / email-change `emailRedirectTo` → `/auth/confirm` (mock or e2e)

## Mock credentials (MSW mode)

- Email: `demo@devneya.com`
- Password: `password123`

Mock subscribe returns a Dodo-shaped checkout URL (`checkout.dodopayments.com`); MSW does not host an in-app checkout page.

## GitHub Pages deploy (main branch)

CI builds with `VITE_USE_MOCKS=false` and deploys `dist/` to GitHub Pages after lint, typecheck, unit tests, and e2e pass.

Required repository secret:

- `VITE_GOTRUE_ANON_KEY` — same value as playground's `VITE_SUPABASE_PUBLIC_KEY` (GoTrue anon/public key from the VM deploy env).

Also requires GitHub Pages enabled for the repo and (when ready) a custom domain CNAME for `app.devneya.com`.

## Auth note

GoTrue is accessed via `@supabase/supabase-js` with `/auth/v1/` → `/auth/` URL rewrite in `src/supabase.ts` (same pattern as playground).

Password recovery returns to `/reset-password`. GoTrue verification mail links
continue through its `/auth/verify` handler until the upstream mail-link issue
is fixed and verified.

## Do not

- Deploy to production VM or change DNS without explicit operator approval.
- Commit secrets (`.env` is gitignored).
- Copy playground canvas/XYFlow complexity into this app without a deliberate scope change.
