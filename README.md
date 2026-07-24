# Devneya App

Primary product web UI for Devneya — account management, API key, subscription.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Default local dev uses **MSW mocks** (`VITE_USE_MOCKS=true`). Mock credentials:

- Email: `demo@devneya.com`
- Password: `password123`

## Verification (definition of done)

```bash
npm run lint
npm run typecheck
npm run test
npm run test:e2e
```

## Environment

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE_URL` | `devneya-api` base URL |
| `VITE_GOTRUE_URL` | GoTrue auth base URL |
| `VITE_GOTRUE_ANON_KEY` | GoTrue anon/public key |
| `VITE_USE_MOCKS` | Enable MSW (`true` for local dev and CI) |

See [AGENTS.md](AGENTS.md) for agent conventions.
