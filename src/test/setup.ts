import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { queryClient } from "@/App";
import { server } from "@/mocks/server";
import { resetMockSession } from "@/mocks/handlers";
import * as supabaseModule from "@/supabase";
import { config } from "@/config";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.spyOn(supabaseModule, "createSessionClient").mockImplementation(origin => ({
    auth: {
      signOut: async (...args: Parameters<typeof supabaseModule.supabase.auth.signOut>) => {
        const result = await supabaseModule.supabase.auth.signOut(...args);
        const key = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
        const raw = localStorage.getItem(key);
        if (!result.error && raw && JSON.parse(raw).refresh_token === origin.refresh_token) localStorage.removeItem(key);
        return result;
      },
      dispose: async () => {},
    },
  }) as ReturnType<typeof supabaseModule.createSessionClient>);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
  resetMockSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

afterAll(() => server.close());
