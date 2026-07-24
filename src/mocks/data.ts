export const MOCK_USER = {
  id: "user-mock-001",
  email: "demo@devneya.com",
  password: "password123",
};

export const MOCK_ACCESS_TOKEN = "mock-access-token-demo";

export const MOCK_VIRTUAL_KEY =
  "sk-bf-mock-309eb063-af7c-4dae-8458-8a05868d2a98";

export const MOCK_CHECKOUT_URL = "/mock-checkout";

export type MockSession = {
  accessToken: string;
  subscribed: boolean;
  cancelled: boolean;
};

export function createDefaultMockSession(): MockSession {
  return {
    accessToken: MOCK_ACCESS_TOKEN,
    subscribed: false,
    cancelled: false,
  };
}

export function mockGoTrueAuthResponse(email: string) {
  return {
    access_token: MOCK_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "mock-refresh-token",
    user: {
      id: MOCK_USER.id,
      aud: "authenticated",
      role: "authenticated",
      email,
      email_confirmed_at: "2026-01-01T00:00:00Z",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}
