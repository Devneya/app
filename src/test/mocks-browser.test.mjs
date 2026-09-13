import { describe, expect, it, vi } from "vitest";
import { drainBeforeClose } from "../../tests/e2e/diagnostics.mjs";

const state = vi.hoisted(() => {
  const listeners = new Map();
  const worker = {
    events: {
      on: (name, listener) => listeners.set(name, listener),
      removeListener: (name, listener) => {
        if (listeners.get(name) === listener) listeners.delete(name);
      },
    },
  };
  return { listeners, worker };
});

vi.mock("msw/browser", () => ({ setupWorker: () => state.worker }));
vi.mock("@/mocks/handlers", () => ({ handlers: [] }));

async function loadCapture() {
  vi.resetModules();
  state.listeners.clear();
  delete globalThis.__devneyaCaptureMockResponse;
  delete globalThis.__devneyaDrainMockResponses;
  await import("../mocks/browser.ts");
  return {
    listener: state.listeners.get("response:mocked"),
    drain: globalThis.__devneyaDrainMockResponses,
  };
}

function event(response) {
  return {
    requestId: "request-1",
    request: { method: "POST", url: "https://api.stage.devneya.com/mock" },
    response: {
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      ...response,
    },
  };
}

describe("MSW mocked response capture", () => {
  it("drains a delayed clone read and waits for the hook", async () => {
    const { listener, drain } = await loadCapture();
    let releaseBody;
    let releaseHook;
    const body = new Promise((resolve) => { releaseBody = resolve; });
    const hookReady = new Promise((resolve) => { releaseHook = resolve; });
    let hookStarted;
    const hook = vi.fn((payload) => {
      hookStarted(payload);
      return hookReady;
    });
    globalThis.__devneyaCaptureMockResponse = hook;
    listener(event({ body: {}, clone: () => ({ text: () => body }) }));
    let drained = false;
    const draining = drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    const captured = new Promise((resolve) => { hookStarted = resolve; });
    releaseBody('{"ok":true}');
    expect(await captured).toMatchObject({ kind: "response", body: '{"ok":true}' });
    expect(drained).toBe(false);
    releaseHook();
    await draining;
    expect(drained).toBe(true);
  });

  it("waits for every Playwright-observed mocked response before detaching the listener", async () => {
    const { listener, drain } = await loadCapture();
    const hook = vi.fn();
    globalThis.__devneyaCaptureMockResponse = hook;
    let drained = false;
    const draining = drain(1).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(state.listeners.get("response:mocked")).toBe(listener);

    listener(event({ body: {}, clone: () => ({ text: async () => "{}" }) }));
    await draining;

    expect(hook).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
    expect(state.listeners.has("response:mocked")).toBe(false);
  });

  it("reports an expected MSW event that never arrives as a teardown failure", async () => {
    const { listener, drain } = await loadCapture();
    globalThis.__devneyaCaptureMockResponse = vi.fn();
    vi.useFakeTimers();

    try {
      const drainTask = drain(1);
      const teardown = drainBeforeClose([drainTask]);
      await vi.advanceTimersByTimeAsync(5000);
      const results = await teardown;
      expect(results[0].status).toBe("rejected");
      expect(results[0].reason.message).toContain("teardown window");
      expect(state.listeners.get("response:mocked")).toBe(listener);

      listener(event({ body: {}, clone: () => ({ text: async () => "{}" }) }));
      await drainTask;
      expect(state.listeners.has("response:mocked")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards synchronous clone failures through the diagnostic hook", async () => {
    const { listener, drain } = await loadCapture();
    const hook = vi.fn();
    globalThis.__devneyaCaptureMockResponse = hook;
    listener(event({ body: {}, clone: () => { throw new Error("clone failed"); } }));
    await drain();
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      error: expect.objectContaining({ name: "Error", message: "clone failed" }),
    }));
  });

  it("reports a missing diagnostic hook instead of silently dropping the mocked body", async () => {
    const { listener, drain } = await loadCapture();
    const error = vi.spyOn(globalThis.console, "error").mockImplementation(() => {});

    try {
      listener(event({ body: {}, clone: () => ({ text: async () => "{}" }) }));
      await drain();
      expect(error).toHaveBeenCalledWith("MSW mocked response capture hook unavailable: request-1");
    } finally {
      error.mockRestore();
    }
  });
});
