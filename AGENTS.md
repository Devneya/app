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

CRITICALLY IMPORTANT: for every failure, retain the complete safe message and relevant log, identify
the evidence-backed root cause or state the exact unknown and needed evidence,
compare remediation options with their tradeoffs, choose and verify the fix,
and record the decision in `control-plane/docs/troubleshooting-decisions.md`.
Capture successful output as well as failures from browser console/network and helper
commands; record collection failures; redact credentials and private data.

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

### Auth coverage

- `AuthProvider.test.tsx` verifies signup redirects to `/auth/confirm` with and
  without an immediate session, and trimmed email changes redirect there while
  propagating provider errors.
- `AuthConfirmPage.test.tsx` covers success and error hashes, session loading,
  history replacement, decoded error descriptions, the no-session timeout, and
  the sign-in route.

## Mock credentials (MSW mode)

- Email: `demo@devneya.com`
- Password: `password123`

Mock subscribe returns a Dodo-shaped checkout URL (`checkout.dodopayments.com`); MSW does not host an in-app checkout page.

## Releases and deployment

Pushes to `main` run checks and publish staging and production bundles under a
full-source-commit tag. Pushes never deploy. Staging deployment and production
GitHub Pages deployment are separate manual workflows that require an exact
release tag. Production deployment follows staging acceptance.

Required repository secret:

- `VITE_GOTRUE_ANON_KEY` — production GoTrue anon/public key.
- `VITE_GOTRUE_STAGE_ANON_KEY` — staging GoTrue public client key in repository variables.
- Staging deployment uses the `CLOUDFLARE_PAGES_WRITE_TOKEN` Actions secret and `CLOUDFLARE_ACCOUNT_ID` repository variable.

GitHub Pages serves production at `app.devneya.com`; DNS and Pages custom-domain settings are managed outside this repository.

## Auth note

GoTrue is accessed via `@supabase/supabase-js` with `/auth/v1/` → `/auth/` URL rewrite in `src/supabase.ts` (same pattern as playground).

Password recovery returns to `/reset-password`. GoTrue verification mail links
continue through its `/auth/verify` handler until the upstream mail-link issue
is fixed and verified.

## Do not

- Deploy to production VM or change DNS without explicit operator approval.
- Commit secrets (`.env` is gitignored).
- Copy playground canvas/XYFlow complexity into this app without a deliberate scope change.
