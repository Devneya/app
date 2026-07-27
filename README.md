# Devneya App

Primary product web UI for Devneya — account management, API key, subscription.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Then open the URL Vite prints (usually **http://localhost:5173** or **http://127.0.0.1:5173**).
The dev server must stay running in that terminal — if the link fails with "connection refused",
you likely closed the terminal or never started `npm run dev`.

If `localhost` fails but `127.0.0.1` works, use `127.0.0.1` (IPv6 vs IPv4 mismatch on some systems).
In Cursor remote SSH, use the **Ports** tab forwarded URL, not your laptop's localhost unless port
5173 is forwarded.

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

## GitHub Pages deploy

On push to `main`, CI runs lint → typecheck → unit tests → e2e → production build → GitHub Pages deploy.

Production build uses `VITE_USE_MOCKS=false`, `VITE_API_BASE_URL=https://api.devneya.com`, and `VITE_GOTRUE_ANON_KEY` from a repository secret (same value as playground's `VITE_SUPABASE_PUBLIC_KEY`).

The build copies `dist/index.html` to `dist/404.html` for SPA deep-link fallback on Pages.

Custom domain `app.devneya.com` is planned; DNS CNAME and Pages custom-domain wiring are operator steps (documented in control-plane).
