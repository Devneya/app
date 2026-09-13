import { setupWorker } from "msw/browser";
import { handlers } from "@/mocks/handlers";

export const worker = setupWorker(...handlers);

type MockResponseCaptureHook = (payload: unknown) => void | Promise<void>;

type MockResponseCaptureGlobal = typeof globalThis & {
  __devneyaCaptureMockResponse?: MockResponseCaptureHook;
  __devneyaDrainMockResponses?: (expectedCount?: number) => Promise<void>;
};

type MockResponseEvent = {
  request: Request;
  response: Response;
  requestId: string;
};

const pendingMockResponseCaptures = new Set<Promise<void>>();
const mockResponseWaiters = new Set<{ expectedCount: number; resolve: () => void }>();
let mockResponseEventCount = 0;

const captureMockedResponse = (event: MockResponseEvent) => {
  mockResponseEventCount += 1;
  for (const waiter of mockResponseWaiters) {
    if (mockResponseEventCount >= waiter.expectedCount) {
      mockResponseWaiters.delete(waiter);
      waiter.resolve();
    }
  }
  const hook = (globalThis as MockResponseCaptureGlobal).__devneyaCaptureMockResponse;
  if (typeof hook !== "function") {
    console.error(`MSW mocked response capture hook unavailable: ${event.requestId}`);
    return;
  }
  const context = {
    requestId: event.requestId,
    method: event.request.method,
    url: event.request.url,
    status: event.response.status,
  };
  const capture = Promise.resolve().then(async () => {
    try {
      const body = event.response.body === null ? "" : await event.response.clone().text();
      return await hook({
        kind: "response",
        ...context,
        headers: Object.fromEntries(event.response.headers.entries()),
        body,
      });
    } catch (error: unknown) {
      return await hook({
        kind: "error",
        ...context,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause }
          : { name: "Error", message: String(error), stack: "" },
      });
    }
  });
  pendingMockResponseCaptures.add(capture);
};

worker.events.on("response:mocked", captureMockedResponse);

(globalThis as MockResponseCaptureGlobal).__devneyaDrainMockResponses = async (
  expectedCount = mockResponseEventCount,
) => {
  const waitForExpectedEvents = (expectedCount: number) => {
    if (mockResponseEventCount >= expectedCount) return Promise.resolve();
    return new Promise<void>((resolve) => mockResponseWaiters.add({ expectedCount, resolve }));
  };
  await waitForExpectedEvents(expectedCount);
  worker.events.removeListener("response:mocked", captureMockedResponse);
  await Promise.all([...pendingMockResponseCaptures]);
};
