const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
const gotrueAnonKey = import.meta.env.VITE_GOTRUE_ANON_KEY;
const useMocks = import.meta.env.VITE_USE_MOCKS === "true";

export const config = {
  apiBaseUrl: (apiBaseUrl || "http://127.0.0.1:8080").replace(/\/+$/, ""),
  gotrueAnonKey: gotrueAnonKey || "local-test-key",
  useMocks,
} as const;

export function authBaseUrl(): string {
  return `${config.apiBaseUrl}/auth`;
}
