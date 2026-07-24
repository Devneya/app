export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "https://api.devneya.com",
  gotrueAnonKey: import.meta.env.VITE_GOTRUE_ANON_KEY || "devneya-anon-key",
  useMocks: (import.meta.env.VITE_USE_MOCKS ?? "true") === "true",
} as const;

export function authBaseUrl(): string {
  return `${config.apiBaseUrl.replace(/\/$/, "")}/auth`;
}
