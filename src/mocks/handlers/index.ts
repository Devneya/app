import { http, HttpResponse } from "msw";
import { authBaseUrl, config } from "@/config";
import {
  createDefaultMockSession,
  MOCK_ACCESS_TOKEN,
  MOCK_CHECKOUT_URL,
  MOCK_USER,
  MOCK_VIRTUAL_KEY,
  mockGoTrueAuthResponse,
  type MockSession,
} from "@/mocks/data";

let session: MockSession = createDefaultMockSession();
let mockPassword = MOCK_USER.password;

export function resetMockSession(): void {
  session = createDefaultMockSession();
  mockPassword = MOCK_USER.password;
}

export function setMockSubscribed(value: boolean): void {
  session.subscribed = value;
}

export function getMockPassword(): string {
  return mockPassword;
}

function unauthorized() {
  return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
}

function requireAuth(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length);
  if (token !== session.accessToken) {
    return null;
  }
  return token;
}

const authBase = authBaseUrl();
const apiBase = config.apiBaseUrl.replace(/\/$/, "");

export const authHandlers = [
  http.post(`${authBase}/signup`, async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password || body.password.length < 6) {
      return HttpResponse.json({ error: "invalid request" }, { status: 400 });
    }
    session.accessToken = MOCK_ACCESS_TOKEN;
    mockPassword = body.password;
    return HttpResponse.json(mockGoTrueAuthResponse(body.email));
  }),

  http.post(`${authBase}/token`, async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    if (body.email !== MOCK_USER.email || body.password !== mockPassword) {
      return HttpResponse.json({ error: "invalid credentials" }, { status: 400 });
    }
    return HttpResponse.json(mockGoTrueAuthResponse(MOCK_USER.email));
  }),

  http.post(`${authBase}/recover`, async ({ request }) => {
    const body = (await request.json()) as { email?: string };
    if (!body.email) {
      return HttpResponse.json({ error: "email required" }, { status: 400 });
    }
    // GoTrue returns 200 even when the user is unknown (anti-enumeration).
    return HttpResponse.json({});
  }),

  http.put(`${authBase}/user`, async ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    const body = (await request.json()) as { password?: string };
    if (!body.password || body.password.length < 6) {
      return HttpResponse.json({ error: "invalid password" }, { status: 400 });
    }
    mockPassword = body.password;
    return HttpResponse.json({
      id: MOCK_USER.id,
      email: MOCK_USER.email,
      role: "authenticated",
      updated_at: new Date().toISOString(),
    });
  }),
];

export const accountHandlers = [
  http.get(`${apiBase}/account/key`, ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    return HttpResponse.json({ key: MOCK_VIRTUAL_KEY });
  }),

  http.get(`${apiBase}/account/usage`, ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    const status = session.subscribed
      ? session.cancelled
        ? "cancelled"
        : "active"
      : "none";
    return HttpResponse.json({
      limit: 5,
      used: session.subscribed ? 0.42 : 0,
      subscription_status: status,
    });
  }),

  http.post(`${apiBase}/account/subscribe`, ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    if (session.subscribed && !session.cancelled) {
      return HttpResponse.json({ status: "active" });
    }
    return HttpResponse.json({
      status: "checkout",
      checkout_url: MOCK_CHECKOUT_URL,
    });
  }),

  http.post(`${apiBase}/account/subscribe/cancel`, ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    session.cancelled = true;
    return HttpResponse.json({
      status: "cancelled",
      access_until: "2026-08-24T00:00:00Z",
    });
  }),

  http.post(`${apiBase}/account/logout`, ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    session.accessToken = "revoked-token";
    return HttpResponse.json({ status: "logged_out" });
  }),

  http.delete(`${apiBase}/account`, ({ request }) => {
    if (!requireAuth(request)) {
      return unauthorized();
    }
    session.accessToken = "revoked-token";
    return HttpResponse.json({ status: "deleted" });
  }),
];

export const handlers = [...authHandlers, ...accountHandlers];
