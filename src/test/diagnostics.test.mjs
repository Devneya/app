import { describe, expect, it, vi } from "vitest";
import {
  captureMockResponse,
  drainBeforeClose,
  isAcceptedCaptureFailure,
  missingResponseBodies,
  safeBody,
  safeError,
  safeText,
  safeUrl,
  trackPending,
} from "../../tests/e2e/diagnostics.mjs";

describe("browser diagnostics", () => {
  it("retains complete diagnostic detail", () => {
    const shared = { value: "complete output", card_last_four: "4242" };
    expect(safeBody({ first: shared, second: shared })).toEqual({ first: shared, second: shared });
    const circular = { value: "retained" };
    circular.self = circular;
    expect(safeBody(circular)).toEqual({ value: "retained", self: "[circular]" });
    expect(safeBody({ password: "secret-password", tokenCount: 3, value: 12 })).toEqual({
      password: "secret-password",
      tokenCount: 3,
      value: 12,
    });
    const error = new Error("failed with https://api.stage.devneya.com?token=secret-token");
    error.cause = new Error("nested cause");
    const output = JSON.stringify(safeError(error));
    expect(output).toContain("stack");
    expect(output).toContain("nested cause");
    expect(output).toContain("secret-token");
    expect(safeText("Authorization: Basic dXNlcjpzZWNyZXQ=")).toContain("dXNlcjpzZWNyZXQ=");
    expect(safeUrl("https://provider.example.test/items?cursor=abc&token=secret-token")).toContain("cursor=abc");
    expect(safeUrl("https://provider.example.test/items?cursor=abc&token=secret-token")).toContain("secret-token");
  });

  it("lets the MSW response event own mocked response bodies", () => {
    const observations = [];
    const failures = [];
    const callbacks = {
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: item => failures.push(item),
    };
    captureMockResponse({
      kind: "response",
      requestId: "msw-request-1",
      method: "POST",
      url: "https://api.example.test/auth/token",
      status: 403,
      body: '{"code":"denied"}',
    }, callbacks);
    captureMockResponse({
      kind: "error",
      requestId: "msw-request-2",
      method: "POST",
      url: "https://api.example.test/auth/token",
      status: 403,
      error: { message: "body read failed" },
    }, callbacks);

    expect(observations).toEqual([expect.objectContaining({
      kind: "http",
      responseId: { source: "msw", requestId: "msw-request-1" },
      body: { code: "denied" },
      bodyCaptureStatus: "complete",
    })]);
    expect(failures).toEqual([expect.objectContaining({
      kind: "diagnostic-collection",
      responseId: { source: "msw", requestId: "msw-request-2" },
      operation: "MSW mocked response",
    })]);
  });

  it("reports the completeness status written on each HTTP record", () => {
    const responseId = { source: "playwright", requestId: "request-1" };
    const response = {
      kind: "http",
      responseId,
      method: "GET",
      url: "https://checkout.example.test/poll",
      status: 200,
      captureSource: "playwright",
      bodyCaptured: true,
      bodyCaptureStatus: "unknown",
      bodyCompletenessReason: "request-not-finished",
      body: { result: "bytes" },
    };
    expect(missingResponseBodies([response])).toEqual([expect.objectContaining({
      responseId,
      bodyCaptureStatus: "unknown",
      bodyCompletenessReason: "request-not-finished",
      bodyCaptured: true,
    })]);
    expect(missingResponseBodies([response, { kind: "request-finished", responseId }]))
      .toEqual([expect.objectContaining({
        responseId,
        bodyCaptureStatus: "unknown",
      })]);
    expect(missingResponseBodies([{ ...response, bodyCaptureStatus: "complete" },
      { kind: "request-failed", responseId, error: "net::ERR_ABORTED" }])).toEqual([]);
  });

  it("accepts the documented missing preflight body", () => {
    const failure = {
      kind: "diagnostic-collection",
      operation: "response body",
      method: "OPTIONS",
      responseId: { source: "playwright", requestId: "preflight-1" },
      error: { message: "No data found for resource with given identifier" },
    };
    expect(isAcceptedCaptureFailure(failure, [failure])).toBe(true);
    expect(isAcceptedCaptureFailure({ ...failure, method: "POST" }, [failure])).toBe(false);
  });

  it("accepts renderer disappearance only when paired with the exact response", () => {
    const responseId = { source: "playwright", requestId: "response-1" };
    const frameId = "frame-1";
    const readFailure = {
      kind: "diagnostic-collection",
      operation: "response body",
      responseId,
      frameId,
      diagnosticOrder: 3,
      error: { message: "No data found for resource with given identifier" },
    };
    const requestFailure = {
      kind: "requestfailed",
      responseId,
      frameId,
      diagnosticOrder: 4,
      error: "net::ERR_ABORTED",
    };
    const observations = [{ kind: "frame-detached", frameId, diagnosticOrder: 2 }];

    expect(isAcceptedCaptureFailure(readFailure, [readFailure, requestFailure], observations)).toBe(true);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, {
      ...requestFailure,
      responseId: { source: "playwright", requestId: "response-2" },
    }], observations)).toBe(false);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, requestFailure], [
      { kind: "frame-detached", frameId, diagnosticOrder: 4 },
    ])).toBe(false);
  });

  it("names unfinished reads during teardown and preserves their late errors", async () => {
    vi.useFakeTimers();
    let rejectPending;
    const pending = [];
    const failures = [];
    trackPending(pending, "completed response body", Promise.resolve(), {}, failure => failures.push(failure));
    trackPending(pending, "pending response body", new Promise((resolve, reject) => { rejectPending = reject; }), {
      method: "GET",
      url: "https://api.example.test/subscriptions?sessionKey=private-session&mode=test",
    }, failure => failures.push(failure));
    try {
      const draining = drainBeforeClose(pending);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await draining;
      expect(result[0].status).toBe("rejected");
      expect(result[0].reason.pendingOperations).toMatchObject([{
        operation: "pending response body",
        index: 1,
        url: "https://api.example.test/subscriptions?sessionKey=private-session&mode=test",
        elapsedMs: 5000,
      }]);
      expect(JSON.stringify(result[0].reason.pendingOperations)).toContain("private-session");
      rejectPending(new Error("late reader failure"));
      expect((await Promise.allSettled(pending)).map(item => item.status)).toEqual(["fulfilled", "rejected"]);
      expect(failures[0]).toMatchObject({
        operation: "pending response body",
        error: expect.objectContaining({ message: "late reader failure" }),
      });
      expect(JSON.stringify(failures)).toContain("private-session");
    } finally {
      vi.useRealTimers();
    }
  });
});
