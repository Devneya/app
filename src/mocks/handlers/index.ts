import { http, HttpResponse } from "msw";
import { authBaseUrl, config } from "@/config";
import {
  createDefaultMockSession,
  getMockEmail,
  isMockEmailConfirmed,
  MOCK_ACCESS_TOKEN,
  MOCK_CHECKOUT_URL,
  MOCK_MODELS,
  MOCK_USER,
  MOCK_VIRTUAL_KEY,
  mockGoTrueAuthResponse,
  mockGoTrueUser,
  resetMockUserMetadata,
  setMockEmail,
  setMockEmailConfirmed,
  setMockPendingEmail,
  setMockUserMetadata,
  type MockSession,
} from "@/mocks/data";

let session: MockSession = createDefaultMockSession();
let mockPassword = MOCK_USER.password;

export function resetMockSession(): void {
  session = createDefaultMockSession();
  mockPassword = MOCK_USER.password;
  resetMockUserMetadata();
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
    // Mirror mailer_autoconfirm=false: user created, no session / access_token.
    mockPassword = body.password;
    setMockEmail(body.email);
    setMockEmailConfirmed(false);
    setMockPendingEmail(null);
    return HttpResponse.json({
      ...mockGoTrueUser(body.email, { confirmed: false }),
      confirmation_sent_at: new Date().toISOString(),
    });
  }),

  http.post(`${authBase}/token`, async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    if (body.email !== getMockEmail() || body.password !== mockPassword) {
      return HttpResponse.json(
        { error: "invalid_grant", error_description: "Invalid login credentials" },
        { status: 400 }
      );
    }
    if (!isMockEmailConfirmed()) {
      return HttpResponse.json(
        { error: "invalid_grant", error_description: "Email not confirmed" },
        { status: 400 }
      );
    }
    session.accessToken = MOCK_ACCESS_TOKEN;
    session.cancelled = false;
    return HttpResponse.json(mockGoTrueAuthResponse(getMockEmail()));
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
    const body = (await request.json()) as {
      password?: string;
      email?: string;
      data?: Record<string, unknown>;
    };
    if (body.password !== undefined) {
      if (body.password.length < 6) {
        return HttpResponse.json({ error: "invalid password" }, { status: 400 });
      }
      mockPassword = body.password;
    }
    if (body.email !== undefined) {
      const nextEmail = body.email.trim();
      if (!nextEmail.includes("@")) {
        return HttpResponse.json({ error: "invalid email" }, { status: 400 });
      }
      // Secure email change: keep current email until both confirmations complete.
      setMockPendingEmail(nextEmail);
    }
    if (body.data && typeof body.data === "object") {
      setMockUserMetadata(body.data);
    }
    if (body.password === undefined && body.data === undefined && body.email === undefined) {
      return HttpResponse.json({ error: "invalid request" }, { status: 400 });
    }
    return HttpResponse.json(mockGoTrueUser(getMockEmail()));
  }),

  // supabase.auth.signOut() → POST /auth/logout?scope=global
  http.post(`${authBase}/logout`, () => HttpResponse.json({}, { status: 200 })),
];

export const llmHandlers = [
  http.get(`${apiBase}/llm/v1/models`, () => {
    const now = Math.floor(Date.now() / 1000);
    return HttpResponse.json({
      object: "list",
      data: MOCK_MODELS.map((id) => ({
        id,
        object: "model",
        created: now,
        owned_by: "devneya",
      })),
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

export const handlers = [...authHandlers, ...accountHandlers, ...llmHandlers];
