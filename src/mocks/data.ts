export const MOCK_USER = {
  id: "user-mock-001",
  email: "demo@devneya.com",
  password: "password123",
};

export const MOCK_ACCESS_TOKEN = "mock-access-token-demo";

export const MOCK_VIRTUAL_KEY =
  "sk-bf-mock-309eb063-af7c-4dae-8458-8a05868d2a98";

export const MOCK_CHECKOUT_URL =
  "https://checkout.dodopayments.com/session/mock-checkout-session";

/** Client-facing model aliases — same shape as GET /llm/v1/models. */
export const MOCK_MODELS = ["gpt-oss-20b", "llama-3.3-70b", "qwen3-32b"] as const;

export type MockSession = {
  accessToken: string;
  subscribed: boolean;
  cancelled: boolean;
};

let mockUserMetadata: Record<string, unknown> = {};
let mockEmail = MOCK_USER.email;
let mockEmailConfirmed = true;
let mockPendingEmail: string | null = null;

export function resetMockUserMetadata(): void {
  mockUserMetadata = {};
  mockEmail = MOCK_USER.email;
  mockEmailConfirmed = true;
  mockPendingEmail = null;
}

export function getMockEmail(): string {
  return mockEmail;
}

export function setMockEmail(email: string): void {
  mockEmail = email;
}

export function isMockEmailConfirmed(): boolean {
  return mockEmailConfirmed;
}

export function setMockEmailConfirmed(value: boolean): void {
  mockEmailConfirmed = value;
}

export function getMockPendingEmail(): string | null {
  return mockPendingEmail;
}

export function setMockPendingEmail(email: string | null): void {
  mockPendingEmail = email;
}

export function getMockUserMetadata(): Record<string, unknown> {
  return { ...mockUserMetadata };
}

export function setMockUserMetadata(next: Record<string, unknown>): void {
  mockUserMetadata = { ...mockUserMetadata, ...next };
}

export function createDefaultMockSession(): MockSession {
  return {
    accessToken: MOCK_ACCESS_TOKEN,
    subscribed: false,
    cancelled: false,
  };
}

export function mockGoTrueUser(email: string, options?: { confirmed?: boolean }) {
  const confirmed = options?.confirmed ?? mockEmailConfirmed;
  return {
    id: MOCK_USER.id,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: confirmed ? "2026-01-01T00:00:00Z" : null,
    ...(mockPendingEmail ? { new_email: mockPendingEmail } : {}),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: getMockUserMetadata(),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: new Date().toISOString(),
  };
}

export function mockGoTrueAuthResponse(email: string) {
  return {
    access_token: MOCK_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "mock-refresh-token",
    user: mockGoTrueUser(email, { confirmed: true }),
  };
}
