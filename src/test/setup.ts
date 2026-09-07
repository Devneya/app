import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { queryClient } from "@/App";
import { server } from "@/mocks/server";
import { resetMockSession } from "@/mocks/handlers";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

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
