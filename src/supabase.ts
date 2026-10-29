import { createClient, type Session } from "@supabase/supabase-js";
import { config } from "@/config";

const gotrueFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return fetch(url.replace("/auth/v1/", "/auth/"), init);
};

// All clients use the same persisted session; action clients retain only an
// in-memory snapshot and may mutate that session only while it still matches.
const authStorageKey = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
const lockName = `${authStorageKey}-storage`;
async function storageMutation<T>(fn: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(lockName, fn);
  return fn();
}
const browserStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => storageMutation(() => localStorage.setItem(key, value)),
  removeItem: (key: string) => storageMutation(() => localStorage.removeItem(key)),
};
export function storedSession(): Session | null {
  const raw = localStorage.getItem(authStorageKey);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || typeof (value as Session).refresh_token !== "string") {
    throw new Error("Stored browser session is invalid.");
  }
  return value as Session;
}

export const supabase = createClient(config.apiBaseUrl, config.gotrueAnonKey, {
  global: { fetch: gotrueFetch },
  auth: {
    // GoTrue confirmation / recovery links redirect with tokens in the URL hash.
    flowType: "implicit",
    detectSessionInUrl: true,
    // Let AuthProvider subscribe before URL/session recovery emits its one-time event.
    skipAutoInitialize: true,
    storage: browserStorage,
  },
});

// Reauthentication must not write to the visible browser session.
export function createPasswordClient() {
  return createClient(config.apiBaseUrl, config.gotrueAnonKey, {
    global: { fetch: gotrueFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Recovery uses the same guarded session boundary, including token refresh.
export function createRecoveryClient(session: Session) {
  return createSessionClient(session);
}

export function createSessionClient(origin: Session) {
  let snapshot = JSON.stringify(origin);
  let expectedRefresh = origin.refresh_token;
  const other = new Map<string, string>();
  const check = () => {
    const current = storedSession();
    if (current && current.refresh_token !== expectedRefresh) throw new Error("Browser session changed during cleanup.");
    return current;
  };
  return createClient(config.apiBaseUrl, config.gotrueAnonKey, {
    global: { fetch: gotrueFetch },
    auth: {
      storageKey: authStorageKey,
      storage: {
        getItem: (key: string) => key === authStorageKey ? snapshot : other.get(key) ?? null,
        setItem: (key: string, value: string) => storageMutation(() => {
          if (key !== authStorageKey) { other.set(key, value); return; }
          if (!check()) throw new Error("Browser session is missing during update.");
          const updated: Session = JSON.parse(value);
          localStorage.setItem(key, value);
          snapshot = value;
          expectedRefresh = updated.refresh_token;
        }),
        removeItem: (key: string) => storageMutation(() => {
          if (key !== authStorageKey) { other.delete(key); return; }
          if (check()) localStorage.removeItem(key);
        }),
      },
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    },
  });
}
