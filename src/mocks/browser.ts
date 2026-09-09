import { setupWorker } from "msw/browser";
import { handlers } from "@/mocks/handlers";

export const worker = setupWorker(...handlers);

type MockResponseCaptureHook = (payload: unknown) => void | Promise<void>;

type MockResponseCaptureGlobal = typeof globalThis & {
  __devneyaCaptureMockResponse?: MockResponseCaptureHook;
  __devneyaDrainMockResponses?: () => Promise<void>;
};

type MockResponseEvent = {
  request: Request;
  response: Response;
  requestId: string;
};

const pendingMockResponseCaptures = new Set<Promise<void>>();

const captureMockedResponse = (event: MockResponseEvent) => {
  const hook = (globalThis as MockResponseCaptureGlobal).__devneyaCaptureMockResponse;
  if (typeof hook !== "function") return;
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

(globalThis as MockResponseCaptureGlobal).__devneyaDrainMockResponses = async () => {
  worker.events.removeListener("response:mocked", captureMockedResponse);
  await Promise.all([...pendingMockResponseCaptures]);
};
