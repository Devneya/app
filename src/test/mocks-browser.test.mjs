import { describe, expect, it, vi } from "vitest";

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
});
