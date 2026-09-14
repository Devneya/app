/* global Buffer, URL */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurePageCapture,
  closeCapturedPage,
  drainPending,
  drainBeforeClose,
  installSubscribeResponseCapture,
  installPageDiagnostics,
  captureMockResponse,
  missingResponseBodies,
  classifyLiveRun,
  isAcceptedCaptureFailure,
  isConsoleCopyOfExpectedHttpFailure,
  trackPending,
  safeBody,
  safeError,
  safeText,
  safeUrl,
  summarizeCaptureLifecycle,
} from "../../tests/e2e/diagnostics.mjs";

function fakePage() {
  const listeners = new Map();
  return {
    on(kind, listener) {
      listeners.set(kind, listener);
    },
    off(kind, listener) {
      if (listeners.get(kind) === listener) listeners.delete(kind);
    },
    emit(kind, value) {
      return listeners.get(kind)?.(value);
    },
  };
}

function fakeRequest(overrides = {}) {
  return {
    method: () => "POST",
    resourceType: () => "fetch",
    url: () => "https://api.stage.devneya.com/auth/token?access_token=secret-token",
    allHeaders: async () => ({ authorization: "Bearer secret-token", "x-safe": "yes" }),
    postData: () => JSON.stringify({ password: "secret-password", ok: true }),
    failure: () => null,
    ...overrides,
  };
}

describe("browser diagnostics", () => {
  it("captures each exact subscription POST once and continues other matching traffic", async () => {
    let routeHandler;
    let routeMatcher;
    const page = Object.assign(fakePage(), {
      route: vi.fn(async (matcher, handler) => { routeMatcher = matcher; routeHandler = handler; }),
      unroute: vi.fn(async () => {}),
    });
    const failures = [];
    const pending = [];
    const capture = await installSubscribeResponseCapture(page, {
      apiOrigin: "https://api.example.test",
      pending,
      addFailure: failure => failures.push(failure),
    });
    const request = fakeRequest({
      url: () => "https://api.example.test/account/subscribe",
      postData: () => "{\"price_id\":\"safe\"}",
    });
    const bytes = Buffer.from('{"marker":"exact-request","checkout_url":"https://pay.example.test/private"}');
    const upstream = {
      status: () => 201,
      headers: () => ({ "content-type": "application/json" }),
      body: vi.fn(async () => bytes),
      dispose: vi.fn(async () => {}),
    };
    const route = {
      request: () => request,
      fetch: vi.fn(async options => {
        expect(options).toMatchObject({ maxRedirects: 0, maxRetries: 0 });
        return upstream;
      }),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };

    expect(routeMatcher(new URL("https://api.example.test/account/subscribe"))).toBe(true);
    expect(routeMatcher(new URL("https://api.example.test/account/subscribe/other"))).toBe(false);
    expect(routeMatcher(new URL("https://other.example.test/account/subscribe"))).toBe(false);
    expect(routeMatcher(new URL("https://api.example.test/account/subscribe?token=private"))).toBe(true);
    await routeHandler(route);
    const result = await capture.responseBodies.get(request);
    expect(result).toEqual({
      ok: true,
      status: 201,
      headers: { "content-type": "application/json" },
      bytes,
    });
    expect(route.fetch).toHaveBeenCalledTimes(1);
    expect(route.fulfill).toHaveBeenCalledWith({ response: upstream });
    expect(upstream.body).toHaveBeenCalledTimes(1);
    expect(route.abort).not.toHaveBeenCalled();

    const getRequest = fakeRequest({
      method: () => "GET",
      url: () => "https://api.example.test/account/subscribe",
    });
    await routeHandler({ ...route, request: () => getRequest });
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(capture.responseBodies.has(getRequest)).toBe(false);
    await drainPending(pending);
    await capture.remove();
    expect(page.unroute).toHaveBeenCalledWith(routeMatcher, routeHandler);
    expect(failures).toEqual([]);
  });

  it("fails a subscription route capture explicitly and still releases the route", async () => {
    let routeHandler;
    const page = Object.assign(fakePage(), {
      route: async (_matcher, handler) => { routeHandler = handler; },
      unroute: async () => {},
    });
    const failures = [];
    const request = fakeRequest({ url: () => "https://api.example.test/account/subscribe" });
    const route = {
      request: () => request,
      fetch: async () => { throw new Error("upstream unavailable"); },
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const capture = await installSubscribeResponseCapture(page, {
      apiOrigin: "https://api.example.test",
      addFailure: failure => failures.push(failure),
    });

    await routeHandler(route);
    expect(await capture.responseBodies.get(request)).toMatchObject({ ok: false });
    expect(route.abort).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(failures).toMatchObject([{ kind: "diagnostic-collection", operation: "subscription response route" }]);
  });

  it("attributes console errors to the emitting document, not the script URL", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: failure => failures.push(failure),
    });
    const emitConsole = (text, resourceUrl, documentOrigin) => page.emit("console", {
      type: () => "error",
      text: () => text,
      location: () => ({ url: resourceUrl }),
      args: () => [{ evaluate: async callback => callback() && documentOrigin }],
    });
    await emitConsole(
      "external script error",
      "https://cdn.example.test/bundle.js",
      "https://app.example.test",
    );
    await emitConsole(
      "iframe error",
      "https://checkout.example.test/frame.html",
      "https://checkout.example.test",
    );
    await drainPending(pending);

    const consoleFailures = failures.filter(failure => failure.kind === "console:error");
    expect(consoleFailures.map(failure => [failure.text, failure.consoleOrigin, failure.consoleOriginSource])).toEqual([
      ["external script error", "https://app.example.test", "document-context"],
      ["iframe error", "https://checkout.example.test", "document-context"],
    ]);
    const result = classifyLiveRun({
      requiredAssertions: ["probe completes"],
      assertions: [{ name: "probe completes", passed: true }],
      failures: consoleFailures,
      cleanupStatus: "verified",
      firstPartyOrigins: ["https://app.example.test"],
    });
    expect(result.blockingFailures).toEqual([consoleFailures[0]]);
    expect(result.thirdPartyDiagnostics).toEqual([consoleFailures[1]]);
  });

  it("keeps console origin unknown and blocking when the event context is unavailable", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: failure => failures.push(failure),
    });
    page.emit("console", {
      type: () => "error",
      text: () => "context disappeared",
      location: () => ({ url: "https://cdn.example.test/sdk.js" }),
      args: () => [{ evaluate: async () => { throw new Error("execution context was destroyed"); } }],
    });
    await drainPending(pending);

    expect(observations[0]).toMatchObject({
      kind: "console",
      consoleOriginSource: "unknown",
      consoleAttributionError: { message: "execution context was destroyed" },
    });
    expect(failures.map(failure => failure.kind)).toEqual(["diagnostic-collection", "console:error"]);
    const result = classifyLiveRun({
      requiredAssertions: ["probe completes"],
      assertions: [{ name: "probe completes", passed: true }],
      failures,
      cleanupStatus: "verified",
      firstPartyOrigins: ["https://app.example.test"],
    });
    expect(result.workflowStatus).toBe("failed");
    expect(result.thirdPartyDiagnostics).toEqual([]);
  });

  it("requires the exact blob source for every observed blob response", () => {
    const response = { kind: "http", responseId: { source: "playwright", requestId: "blob-response-1" }, method: "GET", url: "blob:private", status: 200,
      body: { captureSource: "blob-source", blobId: "exact-source" } };
    const source = { kind: "blob-source", blobId: "exact-source", body: "complete source" };
    expect(missingResponseBodies([response])).toMatchObject([{ responseId: response.responseId, captureSource: "blob-source" }]);
    expect(missingResponseBodies([response, { ...source, blobId: "different-source" }])).toHaveLength(1);
    expect(missingResponseBodies([response, {
      ...response,
      responseId: { source: "playwright", requestId: "blob-response-2" },
      body: { captureSource: "blob-source", blobId: "other-source" },
    }, source])).toMatchObject([{ responseId: { requestId: "blob-response-2" } }]);
    expect(missingResponseBodies([response, response, source])).toEqual([]);
    const componentOnly = {
      kind: "capture-component",
      responseId: { source: "playwright", requestId: "blob-component-only" },
      component: "responseBody",
      status: "referenced",
      body: { captureSource: "blob-source", blobId: "missing-component-source" },
    };
    expect(missingResponseBodies([componentOnly])).toMatchObject([{
      responseId: componentOnly.responseId,
      captureSource: "blob-source",
    }]);
    expect(missingResponseBodies([componentOnly, {
      kind: "blob-source",
      blobId: "missing-component-source",
    }])).toEqual([]);
  });
  it("flags each incomplete Playwright response by its own ID, even when tuples match", () => {
    const complete = {
      kind: "http",
      responseId: { source: "playwright", requestId: "request-a" },
      method: "POST",
      url: "https://checkout.example.test/calculate",
      status: 403,
      captureSource: "playwright",
      bodyCaptureComplete: true,
      body: { code: "CHECKOUT_SESSION_CONSUMED" },
    };
    const incomplete = {
      ...complete,
      responseId: { source: "playwright", requestId: "request-b" },
      bodyCaptureComplete: false,
      bodyCaptured: true,
      bodyCaptureStatus: "unknown",
      body: { code: "bytes-with-unknown-completeness" },
    };
    expect(missingResponseBodies([complete, {
      kind: "request-finished",
      responseId: complete.responseId,
    }, incomplete, {
      kind: "request-failed",
      responseId: incomplete.responseId,
    }])).toEqual([expect.objectContaining({
      responseId: incomplete.responseId,
      captureSource: "playwright",
      bodyCaptureStatus: "unknown",
      bodyCaptured: true,
      body: { code: "bytes-with-unknown-completeness" },
    })]);
    expect(missingResponseBodies([incomplete, complete, {
      kind: "request-finished",
      responseId: complete.responseId,
    }, {
      kind: "request-failed",
      responseId: incomplete.responseId,
    }])).toHaveLength(1);
    const failedRead = {
      ...incomplete,
      responseId: { source: "playwright", requestId: "request-c" },
      bodyCaptureStatus: "incomplete",
      bodyCaptured: false,
      body: { collection_error: ["body unavailable"] },
    };
    expect(missingResponseBodies([failedRead, {
      kind: "request-finished",
      responseId: failedRead.responseId,
    }])).toMatchObject([{ responseId: failedRead.responseId, bodyCaptureStatus: "incomplete" }]);
  });
  it("reconciles delegated MSW responses with captured bodies without merging identical requests", () => {
    const tuple = { method: "POST", url: "https://api.example.test/auth/token", status: 403 };
    const delegated = id => ({
      kind: "mock-response-delegated",
      responseId: { source: "playwright", requestId: id },
      ...tuple,
    });
    const captured = id => ({
      kind: "http",
      responseId: { source: "msw", requestId: id },
      ...tuple,
      captureSource: "msw-response:mocked",
      bodyCaptureComplete: true,
      body: { code: "denied" },
    });
    const twoDelegated = [delegated("playwright-a"), delegated("playwright-b")];
    expect(missingResponseBodies([
      { ...delegated("playwright-a"), kind: "response-received" },
      delegated("playwright-a"),
      captured("msw-a"),
    ])).toEqual([]);
    expect(missingResponseBodies([...twoDelegated, captured("msw-a")])).toEqual([
      expect.objectContaining({
        responseId: { source: "playwright", requestId: "playwright-a" },
        captureSource: "msw-response:mocked",
      }),
    ]);
    expect(missingResponseBodies([...twoDelegated, captured("msw-a"), captured("msw-b")])).toEqual([]);
    expect(missingResponseBodies([delegated("playwright-a"), captured("msw-a"), captured("msw-extra")])).toEqual([
      expect.objectContaining({
        responseId: { source: "msw", requestId: "msw-extra" },
        captureSource: "msw-response:mocked-unmatched",
      }),
    ]);
    expect(missingResponseBodies([
      ...twoDelegated,
      captured("msw-duplicate-id"),
      captured("msw-duplicate-id"),
    ])).toContainEqual(expect.objectContaining({
      responseId: { source: "msw", requestId: "msw-duplicate-id" },
      captureSource: "msw-response:mocked-duplicate",
    }));
  });
  it("does not report explicitly bodyless redirects as missing response bodies", () => {
    const redirect = {
      kind: "http",
      responseId: { source: "playwright", requestId: "request-redirect" },
      method: "GET",
      url: "https://example.test/redirect",
      status: 302,
      captureSource: "playwright",
      bodyCaptureComplete: false,
      bodyCaptureStatus: "bodyless",
      body: { unavailable: true, reason: "Playwright does not expose response bodies for 3xx responses" },
    };
    expect(missingResponseBodies([redirect])).toEqual([]);
  });
  it("detects a response-body reader that never reaches an aggregate record", () => {
    const responseId = { source: "playwright", requestId: "playwright-request-pending" };
    const response = {
      kind: "response-received",
      responseId,
      method: "GET",
      url: "https://cdn.example.test/file",
      status: 200,
    };
    expect(missingResponseBodies([response, {
      kind: "capture-component-started",
      responseId,
      component: "responseBody",
      startedAt: "2026-09-14T10:00:00.000Z",
    }])).toEqual([expect.objectContaining({
      responseId,
      bodyCaptureStatus: "pending",
      bodyCompletenessReason: "body-capture-pending",
    })]);
    expect(missingResponseBodies([response, {
      kind: "capture-component",
      responseId,
      component: "responseBody",
      status: "captured",
      body: { message: "saved" },
    }])).toEqual([expect.objectContaining({
      responseId,
      bodyCaptureStatus: "unknown",
      bodyCompletenessReason: "request-not-finished",
      bodyCaptured: true,
      body: { message: "saved" },
    })]);
    expect(missingResponseBodies([response, {
      kind: "capture-component",
      responseId,
      component: "responseBody",
      status: "captured",
      body: { message: "saved" },
    }, {
      kind: "request-finished",
      responseId,
    }])).toEqual([]);
  });
  it("does not call bytes from an aborted or unterminated request complete", () => {
    const responseId = { source: "playwright", requestId: "playwright-request-aborted" };
    const body = { result: "bytes-remain-available" };
    const records = [
      { kind: "response-received", responseId, status: 200, method: "GET", url: "https://checkout.example.test/poll" },
      { kind: "capture-component", responseId, component: "responseBody", status: "captured", bodyCaptured: true, body },
      { kind: "http", responseId, status: 200, method: "GET", url: "https://checkout.example.test/poll", captureSource: "playwright", bodyCaptureComplete: true, bodyCaptureStatus: "complete", body },
      { kind: "request-failed", responseId, error: "net::ERR_ABORTED" },
    ];

    expect(missingResponseBodies(records)).toEqual([expect.objectContaining({
      responseId,
      bodyCaptureStatus: "unknown",
      bodyCompletenessReason: "request-failed",
      bodyCaptured: true,
      body,
    })]);
    expect(summarizeCaptureLifecycle(records).requests[0]).toMatchObject({
      responseBodyStatus: "unknown",
      responseBodyCaptured: true,
      responseBodyCompletenessReason: "request-failed",
    });
    expect(summarizeCaptureLifecycle([...records, { kind: "request-finished", responseId }])
      .requests[0].responseBodyStatus).toBe("unknown");
    expect(missingResponseBodies(records.filter(item => item.kind === "response-received" || item.kind === "request-failed")))
      .toEqual([expect.objectContaining({
        responseId,
        bodyCaptureStatus: "incomplete",
        bodyCompletenessReason: "request-failed",
      })]);

    const finishedBeforeBody = [
      { kind: "request-finished", responseId },
      ...records.filter(item => item.kind !== "request-failed"),
    ];
    const finishedAfterBody = [
      ...records.filter(item => item.kind !== "request-failed"),
      { kind: "request-finished", responseId },
    ];
    expect(missingResponseBodies(finishedBeforeBody)).toEqual([]);
    expect(missingResponseBodies(finishedAfterBody)).toEqual([]);
    expect(summarizeCaptureLifecycle(finishedAfterBody).requests[0].responseBodyStatus).toBe("complete");

    const routeFetched = records.map(item => item.kind === "http"
      ? { ...item, captureSource: "playwright-route-fetch" }
      : item);
    expect(missingResponseBodies(routeFetched)).toEqual([]);
  });
  it("summarizes lifecycle by exact request ID without copying response bodies", () => {
    const first = { source: "playwright", requestId: "playwright-request-1" };
    const second = { source: "playwright", requestId: "playwright-request-2" };
    const delegated = { source: "playwright", requestId: "playwright-request-3" };
    const summary = summarizeCaptureLifecycle([
      { kind: "request-started", responseId: first, method: "GET", resourceType: "script", url: "https://cdn.example.test/js?token=private-token", timelineSequence: 1, eventAt: "2026-09-14T10:00:00.000Z", eventMonotonicMs: 1 },
      { kind: "request-started", responseId: second, method: "GET", url: "https://cdn.example.test/js?token=private-token", timelineSequence: 2, eventAt: "2026-09-14T10:00:00.001Z", eventMonotonicMs: 2 },
      { kind: "response-received", responseId: first, status: 200, resourceType: "script", fromServiceWorker: false, timelineSequence: 3, eventAt: "2026-09-14T10:00:00.010Z", eventMonotonicMs: 10 },
      { kind: "capture-component-started", responseId: first, component: "responseBody", startedAt: "2026-09-14T10:00:00.010Z" },
      { kind: "capture-component", responseId: first, component: "responseBody", status: "captured", captureSource: "playwright", body: { secret: "private-body" }, elapsedMs: 4, completedMonotonicMs: 14 },
      { kind: "http", responseId: first, status: 200, resourceType: "script", captureSource: "playwright", bodyCaptureComplete: true, bodyCaptureStatus: "complete" },
      { kind: "request-finished", responseId: first, timelineSequence: 7 },
      { kind: "response-received", responseId: second, status: 200, timelineSequence: 4, eventAt: "2026-09-14T10:00:00.020Z", eventMonotonicMs: 20 },
      { kind: "capture-component-started", responseId: second, component: "responseBody", startedAt: "2026-09-14T10:00:00.020Z" },
      { kind: "failure", failureKind: "diagnostic-collection", responseId: second, operation: "response body", error: { message: "Protocol error: token=private-token" } },
      { kind: "request-started", responseId: delegated, method: "POST", url: "https://api.example.test/auth/token", timelineSequence: 5, eventAt: "2026-09-14T10:00:00.030Z", eventMonotonicMs: 30 },
      { kind: "response-received", responseId: delegated, status: 200, fromServiceWorker: true, timelineSequence: 6, eventAt: "2026-09-14T10:00:00.040Z", eventMonotonicMs: 40 },
      { kind: "mock-response-delegated", responseId: delegated, method: "POST", url: "https://api.example.test/auth/token", status: 200 },
      { kind: "http", responseId: { source: "msw", requestId: "msw-request-1" }, method: "POST", url: "https://api.example.test/auth/token", status: 200, captureSource: "msw-response:mocked", bodyCaptureComplete: true, body: { result: "private-mock-body" } },
      { kind: "frame-detached", frameId: "playwright-frame-1", timelineSequence: 7, eventAt: "2026-09-14T10:00:05.000Z" },
      { kind: "capture-shutdown", phase: "page-close-requested", pendingOperations: [{
        operation: "response body capture",
        responseId: second,
        method: "GET",
        url: "https://cdn.example.test/js?token=private-token",
        elapsedMs: 5000,
        evidence: { components: { responseBody: "pending" } },
      }] },
    ]);

    expect(summary).toMatchObject({
      requestCount: 3,
      responseCount: 3,
      requests: [
        { requestId: first.requestId, responseBodyStatus: "complete", captureSource: "playwright", resourceType: "script", fromServiceWorker: false, httpRecord: true,
          components: { responseBody: { status: "captured", completedMonotonicMs: 14 } } },
        { requestId: second.requestId, responseBodyStatus: "pending", failures: [{ kind: "diagnostic-collection", operation: "response body", message: "Protocol error: token=[redacted]" }] },
        { requestId: delegated.requestId, responseBodyStatus: "delegated", delegatedToMSW: true, captureSource: "msw-response:mocked" },
      ],
      frameEvents: [{ kind: "frame-detached", frameId: "playwright-frame-1" }],
      mswResponses: [{ requestId: "msw-request-1", bodyCaptureComplete: true }],
      pendingAtClose: [{ requestId: second.requestId, elapsedMs: 5000 }],
    });
    expect(summary.requests[0].events.map(event => event.timelineSequence)).toEqual([1, 3, 7]);
    expect(JSON.stringify(summary)).not.toContain("private-token");
    expect(JSON.stringify(summary)).not.toContain("private-body");
    expect(JSON.stringify(summary)).not.toContain("private-mock-body");
  });
  it("keeps same-tuple Playwright responses distinct and links each failure to its response", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: item => failures.push(item),
    });
    for (const code of ["first-denial", "second-denial"]) {
      const request = fakeRequest({
        method: () => "POST",
        url: () => "https://checkout.example.test/calculate",
        allHeaders: async () => ({}),
        postData: () => null,
      });
      page.emit("response", {
        request: () => request,
        url: request.url,
        status: () => 403,
        resourceType: () => "fetch",
        allHeaders: async () => ({ "content-type": "application/json" }),
        body: async () => Buffer.from(JSON.stringify({ code })),
      });
      page.emit("requestfinished", request);
    }
    await drainPending(pending);

    const responses = observations.filter(item => item.kind === "http");
    const httpFailures = failures.filter(item => item.kind === "http");
    expect(responses).toHaveLength(2);
    expect(responses[0].responseId).not.toEqual(responses[1].responseId);
    expect(responses.map(item => item.body.code).sort()).toEqual(["first-denial", "second-denial"]);
    expect(httpFailures.map(item => item.responseId).sort((a, b) => a.requestId.localeCompare(b.requestId)))
      .toEqual(responses.map(item => item.responseId).sort((a, b) => a.requestId.localeCompare(b.requestId)));
    expect(missingResponseBodies(observations)).toEqual([]);
  });
  it("does not borrow a finished request's status for another same-tuple body", async () => {
    const page = fakePage();
    const observations = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: () => {},
    });
    const requests = ["first-body", "second-body"].map(code => ({
      code,
      request: fakeRequest({
        method: () => "GET",
        url: () => "https://cdn.example.test/shared.js",
        allHeaders: async () => ({}),
        postData: () => null,
      }),
    }));
    for (const { code, request } of requests) {
      page.emit("response", {
        request: () => request,
        url: () => request.url(),
        status: () => 200,
        resourceType: () => "script",
        allHeaders: async () => ({ "content-type": "application/json" }),
        body: async () => Buffer.from(JSON.stringify({ code })),
      });
    }
    page.emit("requestfinished", requests[0].request);
    await drainPending(pending);

    const responses = observations.filter(item => item.kind === "http");
    expect(responses).toHaveLength(2);
    expect(responses[0].responseId).not.toEqual(responses[1].responseId);
    expect(responses.map(item => [item.body.code, item.bodyCaptureStatus])).toEqual([
      ["first-body", "complete"],
      ["second-body", "unknown"],
    ]);
    expect(missingResponseBodies(observations)).toEqual([expect.objectContaining({
      responseId: responses[1].responseId,
      bodyCaptureStatus: "unknown",
      bodyCaptured: true,
    })]);
  });
  it("marks a missing MSW response-body hook as incomplete capture", async () => {
    const page = fakePage();
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: () => {},
      addFailure: item => failures.push(item),
    });

    await page.emit("console", {
      type: () => "error",
      text: () => "MSW mocked response capture hook unavailable: request-1",
      args: () => [],
      location: () => ({ url: "" }),
    });
    await Promise.all(pending);

    expect(failures).toContainEqual(expect.objectContaining({
      kind: "diagnostic-collection",
      operation: "MSW mocked response body hook",
    }));
  });
  it("records failed requests separately from HTTP responses", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: item => failures.push(item),
    });
    const request = fakeRequest({ failure: () => ({ errorText: "connection reset" }) });
    page.emit("requestfailed", request);
    await drainPending(pending);

    expect(observations.filter(item => item.kind === "requestfailed")).toHaveLength(1);
    expect(observations.find(item => item.kind === "request-failed").timelineSequence).toBeDefined();
    expect(failures).toMatchObject([{ kind: "requestfailed", responseId: { source: "playwright" } }]);
  });
  it("treats HEAD, 204, 304, and redirects as explicitly bodyless", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: item => failures.push(item),
    });
    for (const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 304], ["GET", 302]]) {
      const request = fakeRequest({
        method: () => method,
        url: () => `https://api.example.test/bodyless/${method}-${status}`,
        allHeaders: async () => ({}),
        postData: () => null,
      });
      page.emit("response", {
        request: () => request,
        url: request.url,
        status: () => status,
        resourceType: () => "fetch",
        allHeaders: async () => ({}),
        body: async () => { throw new Error("bodyless response body was requested"); },
      });
    }
    await drainPending(pending);

    const responses = observations.filter(item => item.kind === "http");
    expect(responses).toHaveLength(4);
    expect(responses.every(item => item.bodyCaptureComplete && item.bodyCaptureStatus === "bodyless")).toBe(true);
    expect(missingResponseBodies(observations)).toEqual([]);
    expect(failures).toEqual([]);
  });
  it("keeps third-party errors visible without failing a verified workflow, including Airwallex capture gaps", () => {
    const result = classifyLiveRun({
      requiredAssertions: ["checkout activates subscription"],
      assertions: [{ name: "checkout activates subscription", passed: true }],
      failures: [
        { kind: "http", url: "https://checkout.example.test/calculate", status: 403 },
        { kind: "console:error", location: { url: "https://checkout.example.test/sdk.js" } },
        { kind: "diagnostic-collection", operation: "response body", url: "https://bws.sandbox.airwallex.com/bws/v1/payment" },
      ],
      cleanupStatus: "verified",
      firstPartyOrigins: ["https://app.example.test", "https://api.example.test"],
    });

    expect(result.workflowStatus).toBe("passed");
    expect(result.cleanupStatus).toBe("verified");
    expect(result.captureStatus).toBe("incomplete");
    expect(result.thirdPartyDiagnostics).toHaveLength(3);
    expect(result.blockingFailures).toEqual([]);
  });
  it("allows a console copy only when the exact expected HTTP failure is also recorded", () => {
    const url = "https://api.example.test/auth/logout?scope=local";
    const responseFailure = { kind: "http", method: "POST", status: 403, url };
    const consoleFailure = {
      kind: "console:error",
      text: "Failed to load resource: the server responded with a status of 403 ()",
      location: { url },
    };
    const failures = [responseFailure, consoleFailure];
    const expectedHttpFailure = failure => failure.kind === "http" && failure.method === "POST" &&
      failure.status === 403 && failure.url.endsWith("/auth/logout?scope=local");
    expect(isConsoleCopyOfExpectedHttpFailure(consoleFailure, failures, expectedHttpFailure)).toBe(true);
    expect(isConsoleCopyOfExpectedHttpFailure({ ...consoleFailure, location: { url: "" } }, failures, expectedHttpFailure)).toBe(false);
    expect(isConsoleCopyOfExpectedHttpFailure({ ...consoleFailure, location: { url: "https://api.example.test/auth/token" } }, failures, expectedHttpFailure)).toBe(false);
    expect(isConsoleCopyOfExpectedHttpFailure({ ...consoleFailure, text: "Failed to load resource: 403" }, failures, expectedHttpFailure)).toBe(false);
    const result = classifyLiveRun({
      requiredAssertions: ["browser account deletion completes"],
      assertions: [{ name: "browser account deletion completes", passed: true }],
      failures,
      cleanupStatus: "verified",
      firstPartyOrigins: ["https://api.example.test"],
      expectedHttpFailure,
      expectedConsoleFailure: isConsoleCopyOfExpectedHttpFailure,
    });

    expect(result.workflowStatus).toBe("passed");
    expect(result.expectedHttpFailures).toHaveLength(1);
    expect(result.expectedConsoleFailures).toEqual([consoleFailure]);
  });
  it("blocks first-party and unknown-source failures", () => {
    const result = classifyLiveRun({
      requiredAssertions: ["checkout activates subscription"],
      assertions: [{ name: "checkout activates subscription", passed: true }],
      failures: [
        { kind: "requestfailed", url: "https://api.example.test/account" },
        { kind: "diagnostic-collection", operation: "capture response body" },
      ],
      cleanupStatus: "verified",
      firstPartyOrigins: ["https://app.example.test", "https://api.example.test"],
    });

    expect(result.workflowStatus).toBe("failed");
    expect(result.captureStatus).toBe("incomplete");
    expect(result.blockingFailures).toHaveLength(2);
  });
  it("requires each named workflow assertion and verified cleanup", () => {
    const result = classifyLiveRun({
      requiredAssertions: ["login succeeds", "checkout activates subscription"],
      assertions: [
        { name: "login succeeds", passed: true },
        { name: "checkout activates subscription", passed: false },
      ],
      failures: [],
      cleanupStatus: "failed",
      firstPartyOrigins: [],
      evidenceWriteFailed: true,
    });

    expect(result.workflowStatus).toBe("failed");
    expect(result.missingAssertions).toEqual(["checkout activates subscription"]);
    expect(result.failedAssertions).toHaveLength(1);
    expect(result.blockingFailures.map(failure => failure.kind)).toContain("cleanup");
    expect(result.blockingFailures.map(failure => failure.kind)).toContain("evidence-write");
  });
  it("accepts only a renderer disappearance paired to the exact response ID", () => {
    const responseId = { source: "playwright", requestId: "playwright-request-7" };
    const frameId = "playwright-frame-2";
    const readFailure = {
      kind: "diagnostic-collection",
      operation: "response body",
      responseId,
      frameId,
      at: "2026-09-13T12:00:00.200Z",
      diagnosticOrder: 3,
      error: { message: "Protocol error (Network.getResponseBody): No data found for resource with given identifier" },
    };
    const verificationFailure = {
      kind: "diagnostic-collection",
      operation: "verify complete response body capture",
      responseId,
      frameId,
    };
    const requestFailure = {
      kind: "requestfailed",
      responseId,
      frameId,
      diagnosticOrder: 4,
      error: "net::ERR_ABORTED",
    };
    const observations = [{ kind: "frame-detached", frameId, at: "2026-09-13T12:00:00.200Z", diagnosticOrder: 2 }];
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, requestFailure])).toBe(false);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, requestFailure], observations)).toBe(true);
    expect(isAcceptedCaptureFailure(verificationFailure, [readFailure, verificationFailure, requestFailure], observations)).toBe(true);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, {
      ...requestFailure,
      responseId: { source: "playwright", requestId: "playwright-request-8" },
    }], observations)).toBe(false);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, {
      ...requestFailure,
      frameId: "playwright-frame-other",
    }], observations)).toBe(false);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, requestFailure], [
      { kind: "frame-detached", frameId, at: "2026-09-13T12:00:00.200Z", diagnosticOrder: 4 },
    ])).toBe(false);
    expect(isAcceptedCaptureFailure(readFailure, [readFailure, requestFailure], [
      { kind: "frame-detached", frameId, at: "2026-09-13T12:00:00.200Z" },
    ])).toBe(false);
    const targetClosedFailure = {
      ...readFailure,
      error: { message: "Target page, context or browser has been closed" },
    };
    expect(isAcceptedCaptureFailure(targetClosedFailure, [targetClosedFailure, requestFailure], observations)).toBe(false);

    const result = classifyLiveRun({
      requiredAssertions: ["checkout activates subscription"],
      assertions: [{ name: "checkout activates subscription", passed: true }],
      observations,
      failures: [
        { kind: "console:warning", location: { url: "https://checkout.example.test/sdk.js" } },
        readFailure,
        verificationFailure,
        { ...requestFailure, url: "https://checkout.example.test/calculate" },
        { kind: "http", url: "https://api.example.test/auth/logout", status: 403 },
      ],
      cleanupStatus: "verified",
      firstPartyOrigins: ["https://api.example.test"],
      acceptedCaptureFailure: isAcceptedCaptureFailure,
      expectedHttpFailure: failure => failure.url.endsWith("/auth/logout"),
    });

    expect(result.workflowStatus).toBe("passed");
    expect(result.captureStatus).toBe("incomplete");
    expect(result.acceptedCaptureFailures).toHaveLength(2);
    expect(result.expectedHttpFailures).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
  it("keeps mocked responses and body-capture failures attached to their MSW request IDs", () => {
    const observations = [];
    const failures = [];
    const callbacks = {
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: item => failures.push(item),
    };
    const tuple = { method: "POST", url: "https://api.example.test/auth/token", status: 403 };
    captureMockResponse({ kind: "response", requestId: "msw-request-1", ...tuple, body: '{"code":"denied"}' }, callbacks);
    captureMockResponse({ kind: "error", requestId: "msw-request-2", ...tuple, error: { message: "body read failed" } }, callbacks);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      kind: "http",
      responseId: { source: "msw", requestId: "msw-request-1" },
      body: { code: "denied" },
      bodyCaptureComplete: true,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "diagnostic-collection",
      responseId: { source: "msw", requestId: "msw-request-2" },
      operation: "MSW mocked response",
    });
  });
  it("retains ordinary values and shared references while redacting named credentials", () => {
    const shared = { value: "complete output", card_last_four: "4242" };
    expect(safeBody({ first: shared, second: shared })).toEqual({ first: shared, second: shared });
    const error = new Error("same failure");
    expect(safeError(new AggregateError([error, error], "both")).errors[1].stack).toContain("same failure");
    const circular = { value: "retained" };
    circular.self = circular;
    expect(safeBody(circular)).toEqual({ value: "retained", self: "[circular]" });
    expect(safeBody([{ name: "content-type", value: "application/json" }, { name: "Authorization", value: "private-credential" }])).toEqual([
      { name: "content-type", value: "application/json" }, { name: "Authorization", value: "[redacted]" },
    ]);
    expect(safeText('{"name":"Authorization","value":"private-credential"}')).not.toContain("private-credential");
    expect(safeText('{"name":"content-type","value":"application/json"}')).toContain("application/json");
    expect(safeUrl("https://example.test/page#details")).toBe("https://example.test/page#details");
    expect(safeUrl("https://example.test/page#access_token=private-credential")).not.toContain("private-credential");
    expect(safeUrl("not a URL: retained details")).toBe("not a URL: retained details");
  });

  it("retains and sanitizes special enumerable Error properties", () => {
    const error = new Error("request failed");
    Object.defineProperty(error, "__proto__", {
      value: { status: 502, sessionKey: "private-session" },
      enumerable: true,
    });

    const safe = safeError(error);

    expect(Object.hasOwn(safe, "__proto__")).toBe(true);
    expect(safe.__proto__).toEqual({ status: 502, sessionKey: "[redacted]" });
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(JSON.stringify(safe)).not.toContain("private-session");
  });

  it("redacts sensitive URLs used as object keys without dropping collisions", () => {
    const firstUrl = "https://provider.example.test/collect?sessionKey=private-first&mode=test";
    const secondUrl = "https://provider.example.test/collect?sessionKey=private-second&mode=test";
    const safe = safeBody({ [firstUrl]: { status: 200 }, [secondUrl]: { status: 403 } });
    const keys = Object.keys(safe);

    expect(keys).toHaveLength(2);
    expect(keys.every(key => key.includes("sessionKey=[redacted]&mode=test"))).toBe(true);
    expect(Object.values(safe)).toEqual([{ status: 200 }, { status: 403 }]);
    expect(safeBody(safe)).toEqual(safe);
    expect(JSON.stringify(safe)).not.toContain("private-first");
    expect(JSON.stringify(safe)).not.toContain("private-second");
  });

  it("preserves __proto__ as an enumerable diagnostic property", () => {
    const input = JSON.parse('{"__proto__":{"status":"kept","sessionKey":"private-session"}}');
    const safe = safeBody(input);

    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(Object.keys(safe)).toEqual(["__proto__"]);
    expect(safe.__proto__).toEqual({ status: "kept", sessionKey: "[redacted]" });
    expect(JSON.stringify(safe)).toBe('{"__proto__":{"status":"kept","sessionKey":"[redacted]"}}');
  });

  it.each([
    ["application/x-www-form-urlencoded", "value=first&value=second&password=private-credential"],
    ["multipart/form-data; boundary=test-boundary", "--test-boundary\r\nContent-Disposition: form-data; name=\"value\"\r\n\r\nfirst\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"value\"\r\n\r\nsecond\r\n--test-boundary\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\nprivate-credential\r\n--test-boundary--\r\n"],
  ])("retains repeated form values for %s", async (contentType, postData) => {
    const page = fakePage();
    const records = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, { pending, record: (kind, data) => records.push({ kind, ...data }), addFailure: failure => failures.push(failure) });
    const request = fakeRequest({ allHeaders: async () => ({ "content-type": contentType }), postData: () => postData });
    page.emit("response", { request: () => request, url: request.url, status: () => 200, allHeaders: async () => ({}), text: async () => "ok" });
    await drainPending(pending);
    const response = records.find(item => item.kind === "http");
    expect(response.requestBody.fields ?? response.requestBody).toEqual([
      { name: "value", contents: "first" }, { name: "value", contents: "second" }, { name: "password", contents: "[redacted]" },
    ]);
    expect(failures).toEqual([]);
  });

  it("names unfinished teardown reads and retains their late failures", async () => {
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
      expect(result[0].reason.message).toContain("teardown window");
      expect(result[0].reason.pendingOperations).toMatchObject([
        {
          operation: "pending response body",
          index: 1,
          method: "GET",
          url: "https://api.example.test/subscriptions?sessionKey=[redacted]&mode=test",
          startedAt: expect.any(String),
          elapsedMs: 5000,
        },
      ]);
      expect(JSON.stringify(result[0].reason.pendingOperations)).not.toContain("private-session");
      rejectPending(new Error("late reader failure"));
      expect((await drainPending(pending)).map(item => item.status)).toEqual(["fulfilled", "rejected"]);
      expect(failures).toMatchObject([
        { operation: "pending response body", error: { message: "late reader failure" } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("finishes pending Playwright body reads before closing the page", async () => {
    let finishBody;
    let pageClosed = false;
    const body = Buffer.from("{\"captured\":true}");
    const pending = [];
    const observations = [];
    const failures = [];
    const page = Object.assign(fakePage(), { close: async () => { pageClosed = true; } });
    const removeDiagnostics = installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: item => failures.push(item),
    });
    const request = fakeRequest({
      method: () => "GET",
      url: () => "https://api.example.test/pending-body",
      allHeaders: async () => ({}),
      postData: () => null,
    });
    page.emit("response", {
      request: () => request,
      url: request.url,
      status: () => 200,
      resourceType: () => "fetch",
      allHeaders: async () => ({ "content-type": "application/json" }),
      body: () => new Promise(resolve => { finishBody = resolve; }),
    });

    const teardown = closeCapturedPage({ pending, removeDiagnostics, page });
    await Promise.resolve();
    expect(pageClosed).toBe(false);
    page.emit("requestfinished", request);
    finishBody(body);
    await teardown;

    expect(pageClosed).toBe(true);
    expect(observations.find(item => item.kind === "http").body).toEqual({ captured: true });
    expect(observations.find(item => item.kind === "http").bodyCaptureComplete).toBe(true);
    expect(failures).toEqual([]);
  });
  it("saves request evidence before a hanging response-body read and snapshots it before close", async () => {
    vi.useFakeTimers();
    let rejectResponseBody;
    let pageClosed = false;
    const pending = [];
    const observations = [];
    const failures = [];
    const page = Object.assign(fakePage(), {
      close: async () => {
        pageClosed = true;
        rejectResponseBody(new Error("Target page, context or browser has been closed"));
      },
    });
    const record = (kind, item) => observations.push({ kind, ...item });
    const removeDiagnostics = installPageDiagnostics(page, {
      pending,
      record,
      addFailure: failure => failures.push(failure),
    });
    const request = fakeRequest({
      method: () => "GET",
      allHeaders: async () => ({ "x-safe": "request-header" }),
      postData: () => null,
    });

    try {
      page.emit("request", request);
      page.emit("response", {
        request: () => request,
        url: request.url,
        status: () => 200,
        allHeaders: async () => ({ "content-type": "application/json" }),
        body: () => new Promise((resolve, reject) => { rejectResponseBody = reject; }),
      });
      page.emit("requestfinished", request);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();

      expect(observations).toContainEqual(expect.objectContaining({
        kind: "capture-component",
        component: "requestHeaders",
        status: "captured",
        value: { "x-safe": "request-header" },
      }));
      expect(observations).toContainEqual(expect.objectContaining({
        kind: "capture-component",
        component: "responseHeaders",
        status: "captured",
      }));
      expect(observations.some(item => item.kind === "capture-component" && item.component === "responseBody"))
        .toBe(false);

      const timeline = observations.filter(item => [
        "request-started", "response-received", "request-finished",
      ].includes(item.kind));
      expect(timeline.map(item => item.timelineSequence)).toEqual([1, 2, 3]);
      expect(timeline.every(item => typeof item.eventAt === "string" && typeof item.eventMonotonicMs === "number"))
        .toBe(true);
      expect(timeline.every(item => item.responseId.requestId === timeline[0].responseId.requestId)).toBe(true);

      const teardown = closeCapturedPage({ pending, removeDiagnostics, page, record });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await teardown;
      expect(pageClosed).toBe(true);
      const preClose = observations.find(item => item.kind === "capture-shutdown" && item.phase === "page-close-requested");
      const pendingBody = preClose.pendingOperations.find(item => item.operation === "response body capture");
      expect(pendingBody.responseId).toEqual(timeline[0].responseId);
      expect(pendingBody.startedAt).toEqual(expect.any(String));
      expect(pendingBody.elapsedMs).toBeGreaterThanOrEqual(5000);
      expect(pendingBody.evidence).toMatchObject({
        networkState: "finished",
        components: {
          requestHeaders: "captured",
          requestBody: "captured",
          responseHeaders: "captured",
          responseBody: "pending",
        },
        savedComponents: expect.arrayContaining([
          "requestHeaders", "requestBody", "responseHeaders",
        ]),
      });
      expect(JSON.stringify(preClose.pendingOperations)).not.toContain("secret-token");
      expect(result.drainResults.some(item => item.status === "rejected")).toBe(true);
      expect(failures).toContainEqual(expect.objectContaining({
        operation: "response body",
        error: expect.objectContaining({ message: "Target page, context or browser has been closed" }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });
  it("persists a completed response body while request-header capture is still pending", async () => {
    let resolveRequestHeaders;
    const pending = [];
    const observations = [];
    const failures = [];
    const page = fakePage();
    installPageDiagnostics(page, {
      pending,
      record: (kind, item) => observations.push({ kind, ...item }),
      addFailure: failure => failures.push(failure),
    });
    const request = fakeRequest({
      method: () => "GET",
      allHeaders: () => new Promise(resolve => { resolveRequestHeaders = resolve; }),
      postData: () => null,
    });
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      url: request.url,
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      allHeaders: async () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from('{"result":"body-read-first"}'),
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const savedBody = observations.find(item => item.kind === "capture-component" &&
      item.component === "responseBody");
    expect(savedBody).toMatchObject({
      status: "captured",
      bodyCaptured: true,
      bodyCaptureComplete: false,
      bodyCaptureStatus: "unknown",
      body: { result: "body-read-first" },
    });
    expect(observations.some(item => item.kind === "http")).toBe(false);

    page.emit("requestfinished", request);
    resolveRequestHeaders({ "x-safe": "headers-arrived-later" });
    await drainPending(pending);
    expect(observations.find(item => item.kind === "http")).toMatchObject({
      body: { result: "body-read-first" },
      bodyCaptureComplete: true,
      requestHeaders: { "x-safe": "headers-arrived-later" },
    });
    expect(failures).toEqual([]);
  });
  it("reports a rejected capture task only once across teardown drain phases", async () => {
    const pending = [Promise.resolve().then(() => { throw new Error("capture task failed"); })];
    const teardown = await closeCapturedPage({
      pending,
      removeDiagnostics: () => {},
      page: { close: async () => {} },
    });

    const rejected = teardown.drainResults.filter(result => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe("capture task failed");
  });
  it("records listener-removal and page-close failures as failed lifecycle phases", async () => {
    const phases = [];
    const teardown = await closeCapturedPage({
      pending: [],
      removeDiagnostics: async () => { throw new Error("listener removal failed"); },
      page: { close: async () => { throw new Error("page close failed"); } },
      record: (kind, item) => phases.push(item.phase),
    });

    expect(teardown.closeErrors.map(item => item.error.message)).toEqual([
      "listener removal failed", "page close failed",
    ]);
    expect(phases).toContain("diagnostic-listener-removal-failed");
    expect(phases).toContain("page-close-failed");
    expect(phases).not.toContain("diagnostic-listeners-removed");
    expect(phases).not.toContain("page-close-completed");
  });
  it("redacts credentials while retaining exception stacks", () => {
    const error = new Error("failed with https://api.stage.devneya.com?token=secret-token");
    error.cause = new Error("nested cause");
    const output = JSON.stringify({ body: safeBody({ password: "secret-password" }), error: safeError(error) });

    expect(output).toContain("stack");
    expect(output).toContain("nested cause");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("secret-password");
    expect(safeUrl("https://test.checkout.dodopayments.com/opaqueCheckout")).not.toContain("opaqueCheckout");
    expect(safeText('"forterToken":"private-fraud-token"')).not.toContain("private-fraud-token");
    expect(safeBody({ forterToken: "private-fraud-token", sessionId: "cks_private-session" })).toEqual({ forterToken: "[redacted]", sessionId: "[redacted]" });
    const basic = safeText("Authorization: Basic dXNlcjpzZWNyZXQ=");
    expect(basic).toContain("[redacted]");
    expect(basic).not.toContain("dXNlcjpzZWNyZXQ=");
    const aggregate = new AggregateError([new Error("first"), new Error("second")], "many failures");
    expect(safeError(aggregate).errors[0].stack).toContain("Error: first");
    expect(safeUrl("https://api.stage.devneya.com/items?cursor=abc&token=secret-token")).toContain("cursor=abc");
    expect(safeUrl("https://api.stage.devneya.com/items?cursor=abc&token=secret-token")).not.toContain("secret-token");
    expect(safeUrl("https://api.stage.devneya.com/items/123e4567-e89b-12d3-a456-426614174000")).toContain("/items/123e4567-e89b-12d3-a456-426614174000");
    expect(safeUrl("https://api.stage.devneya.com/events/evt_123?payment_id=pmt_456&status=checkout")).toContain("evt_123?payment_id=pmt_456&status=checkout");
    expect(safeUrl("blob:https://static.sandbox.airwallex.com/frame-id?token=secret-token")).toBe("blob:https://static.sandbox.airwallex.com/frame-id?token=%5Bredacted%5D");
    expect(safeUrl("https://checkout.dodopayments.com/payment/shortlink/opaque-capability?return=app")).toContain("/payment/shortlink/[redacted-capability]?return=app");
    expect(safeUrl("https://s3.amazonaws.com/bucket/object?X-Amz-Signature=secret-signature&part=1")).toContain("part=1");
    expect(safeUrl("https://s3.amazonaws.com/bucket/object?X-Amz-Signature=secret-signature&part=1")).not.toContain("secret-signature");
    const body = safeBody({ value: 12, token_count: 3, checkout: { status: "open" }, payment_id: "pmt_456", api_key: "secret-key" });
    expect(body).toMatchObject({ value: 12, token_count: 3, checkout: { status: "open" }, payment_id: "pmt_456", api_key: "[redacted]" });
  });

  it("redacts camel-case credentials in captured JSON bodies and URL queries", () => {
    const credentials = {
      projectKey: "private-project-key",
      sessionKey: "private-session-key",
      deviceToken: "private-device-token",
      sessionId: "private-session-id",
      nonce: "private-nonce",
      privateValue: "private-value",
    };
    const body = safeBody(credentials);
    const bodyText = safeText(JSON.stringify(credentials));
    const diagnosticText = safeText("projectKey=private-project-key sessionKey: private-session-key deviceToken=private-device-token sessionId=private-session-id nonce=private-nonce privateValue=private-value");
    const url = safeUrl("https://provider.example.test/collect?sessionKey=private-session-key&deviceToken=private-device-token&sessionId=private-session-id&nonce=private-nonce&privateValue=private-value&event=kept");

    expect(body).toEqual({
      projectKey: "[redacted]",
      sessionKey: "[redacted]",
      deviceToken: "[redacted]",
      sessionId: "[redacted]",
      nonce: "[redacted]",
      privateValue: "[redacted]",
    });
    expect(bodyText).toBe(JSON.stringify(body));
    expect(diagnosticText).toBe("projectKey=[redacted] sessionKey: [redacted] deviceToken=[redacted] sessionId=[redacted] nonce=[redacted] privateValue=[redacted]");
    expect(url).toContain("event=kept");
    for (const value of Object.values(credentials)) {
      expect(JSON.stringify({ body, bodyText, diagnosticText, url })).not.toContain(value);
    }
  });

  it("redacts every supported camel-case secret key", () => {
    const keys = [
      "password", "secret", "authorization", "cookie", "apiKey", "clientSecret",
      "privateKey", "secretKey", "token", "accessToken", "refreshToken", "idToken",
      "oauthToken", "deviceToken", "forterToken", "paymentToken", "sessionKey",
      "sessionToken", "sessionId", "projectKey", "checkoutUrl", "checkoutLink",
      "portalUrl", "portalLink", "paymentLink", "signature", "sig", "email",
      "cardNumber", "cvv", "cvc", "nonce", "privateValue",
    ];
    const credentials = Object.fromEntries(keys.map(key => [key, `sentinel-${key}`]));
    const body = safeBody(credentials);
    const text = safeText(keys.map(key => `${key}=sentinel-${key}`).join(" "));
    const query = safeUrl(`https://provider.example.test/collect?${keys.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(`sentinel-${key}`)}`).join("&")}`);

    expect(Object.values(body)).toEqual(keys.map(() => "[redacted]"));
    for (const key of keys) {
      const sentinel = `sentinel-${key}`;
      expect(text).not.toContain(sentinel);
      expect(query).not.toContain(sentinel);
    }
  });

  it("redacts URL query secrets without treating the scheme as a field", () => {
    const url = "https://sdk-v2.custom.hs.dodopayments.com/1.1.0/checkout.html?publishableKey=private-publishable&clientSecret=private-client&mode=test";
    for (const scrubUrls of [true, false]) {
      const safe = safeText(url, scrubUrls);
      expect(safe).not.toContain("private-publishable");
      expect(safe).not.toContain("private-client");
      const query = new URL(safe).searchParams;
      expect(query.get("publishableKey")).toBe("[redacted]");
      expect(query.get("clientSecret")).toBe("[redacted]");
      expect(query.get("mode")).toBe("test");
      expect(safeText(safe, scrubUrls)).toBe(safe);
    }
  });

  it("captures successful auth responses, all console output, request headers, and failed requests", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics({
      ...page,
    }, {
      pending,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: (value) => failures.push(value),
    });

    const request = fakeRequest();
    await page.emit("response", {
      request: () => request,
      url: request.url,
      status: () => 200,
      allHeaders: async () => ({ "set-cookie": "secret-cookie", "content-type": "application/json", "x-safe": "yes" }),
      text: async () => JSON.stringify({ access_token: "secret-token", success: true }),
    });
    const deniedRequest = fakeRequest({
      method: () => "POST",
      url: () => "https://api.stage.devneya.com/auth/token",
      allHeaders: async () => ({}),
      postData: () => null,
    });
    await page.emit("response", {
      request: () => deniedRequest,
      url: deniedRequest.url,
      status: () => 403,
      allHeaders: async () => ({ "content-type": "application/json" }),
      text: async () => '{"code":"denied"}',
    });
    for (const type of ["debug", "info", "log", "warning", "error"]) {
      await page.emit("console", {
        type: () => type,
        text: () => type === "log" ? "authentication succeeded" : `${type} output`,
        args: () => [{
          evaluate: async () => {
            throw new Error("primitive console argument was evaluated");
          },
          jsonValue: async () => "authentication-value",
        }, {
          jsonValue: async () => ({ refresh_token: "secret-token", safe: true }),
          evaluate: async (serialize) => serialize({ refresh_token: "secret-token", safe: true }),
        }],
        location: () => ({ url: "https://api.stage.devneya.com/app.js", lineNumber: 4 }),
      });
    }
    const browserAggregate = new AggregateError(
      [new Error("first")],
      "browser aggregate error",
      { cause: new TypeError("nested") },
    );
    browserAggregate.status = 502;
    await page.emit("console", {
      type: () => "error",
      text: () => "browser aggregate error",
      args: () => [{
        jsonValue: async () => ({}),
        evaluate: async (serialize) => serialize(browserAggregate),
      }],
      location: () => ({ url: "https://api.stage.devneya.com/app.js", lineNumber: 5 }),
    });
    await page.emit("pageerror", Object.assign(new Error("browser exception"), { cause: new Error("nested") }));
    await page.emit("requestfailed", {
      ...request,
      failure: () => ({ errorText: "connection reset" }),
    });
    await Promise.all(pending);

    const output = JSON.stringify({ observations, failures });
    expect(output).toContain('"kind":"http"');
    expect(observations.filter((item) => item.kind === "console")).toHaveLength(6);
    expect(output).toContain('"kind":"console"');
    expect(output).toContain("authentication succeeded");
    expect(output).toContain("browser exception");
    expect(output).toContain("stack");
    expect(output).toContain("requestHeaders");
    expect(output).toContain("requestBody");
    expect(output).toContain("connection reset");
    const deniedResponse = observations.find(item => item.kind === "http" && item.url.endsWith("/auth/token"));
    const deniedFailure = failures.find(item => item.kind === "http" && item.url.endsWith("/auth/token"));
    expect(deniedResponse.responseId).toEqual(deniedFailure.responseId);
    expect(observations.filter(item => item.kind === "http" && item.url.endsWith("/auth/token"))).toHaveLength(1);
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("secret-cookie");
    expect(failures.map((item) => item.kind)).toContain("requestfailed");
  });

  it("retains a collection failure as a failure and as response evidence", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: (value) => failures.push(value),
    });
    const request = fakeRequest({
      allHeaders: async () => {
        throw new Error("request headers unavailable");
      },
    });
    await page.emit("response", {
      request: () => request,
      url: request.url,
      status: () => 200,
      allHeaders: async () => ({ "content-type": "application/json" }),
      text: async () => "{}",
    });
    await Promise.all(pending);

    const response = observations.find(item => item.kind === "http");
    expect(response.requestHeaders.collection_error.message).toContain("request headers unavailable");
    expect(response.requestBody).toEqual({ password: "[redacted]", ok: true });
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("diagnostic-collection");
    expect(JSON.stringify(failures)).not.toContain("secret-token");
  });

  it("reports an aggregate write failure once through its tracked task", async () => {
    const page = fakePage();
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: kind => {
        if (kind === "http") throw new Error("private trace append failed");
      },
      addFailure: failure => failures.push(failure),
    });
    const request = fakeRequest({ postData: () => null });

    await page.emit("response", {
      request: () => request,
      url: request.url,
      status: () => 200,
      allHeaders: async () => ({ "content-type": "text/plain" }),
      body: async () => Buffer.from("complete"),
    });
    await Promise.allSettled(pending);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: "diagnostic-collection",
      operation: "aggregate response record",
      error: { message: "private trace append failed" },
    });
  });

  it("keeps top-level capture rejections visible to the drain", async () => {
    const page = fakePage();
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: () => {},
      addFailure: (value) => failures.push(value),
    });

    await page.emit("console", {
      type: () => "log",
      text: () => { throw new Error("console text unavailable"); },
      args: () => {
        throw new Error("console arguments unavailable");
      },
      location: () => ({}),
    });

    const settled = await drainPending(pending);
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("rejected");
    expect(failures[0].error.message).toContain("console text unavailable");
  });

  it("records 3xx bodies as unavailable under the Playwright response contract", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: (value) => failures.push(value),
    });
    const request = fakeRequest({ method: () => "GET", postData: () => null });
    let bodyRead = false;
    await page.emit("response", {
      request: () => request,
      url: () => "https://app.stage.devneya.com/login",
      status: () => 308,
      allHeaders: async () => ({ location: "/login/", "content-type": "text/html" }),
      body: async () => {
        bodyRead = true;
        throw new Error("response body is unavailable for redirect responses");
      },
    });
    await Promise.all(pending);

    const response = observations.find(item => item.kind === "http");
    expect(response.body).toEqual({
      unavailable: true,
      reason: "Playwright does not expose response bodies for 3xx responses",
    });
    expect(response.headers.location).toBe("/login/");
    expect(bodyRead).toBe(false);
    expect(failures).toHaveLength(0);
  });

  it("removes listeners before page teardown", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    const removeDiagnostics = installPageDiagnostics(page, {
      pending,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: (value) => failures.push(value),
    });

    removeDiagnostics();
    await page.emit("console", {
      type: () => "error",
      text: () => "late console output",
      args: () => [],
      location: () => ({}),
    });
    await page.emit("response", {
      request: () => fakeRequest(),
      url: () => "https://app.stage.devneya.com/late-font.woff2",
      status: () => 200,
      allHeaders: async () => ({ "content-type": "font/woff2" }),
      body: async () => Buffer.from([1, 2, 3]),
    });
    await Promise.all(pending);

    expect(observations).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it("configures page capture and installs the blob source hook", async () => {
    const bindings = [];
    const scripts = [];
    const page = {
      exposeBinding: async (...args) => bindings.push(args),
      addInitScript: async script => scripts.push(script),
    };
    const configured = await configurePageCapture(page, { record: () => {}, addFailure: () => {} });

    expect(bindings.some(([name]) => name === "__devneyaCaptureBlob")).toBe(true);
    expect(scripts).toHaveLength(2);
    expect(configured.responseBodyCapture).toContain("Playwright response bodies");
    expect(Object.keys(configured)).toEqual(["responseBodyCapture"]);
  });

  it("stores binary response bytes privately instead of decoding them as text", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    const artifactDir = await mkdtemp(join(tmpdir(), "devneya-diagnostics-"));
    try {
      installPageDiagnostics(page, {
        pending,
        binaryArtifactDir: artifactDir,
        record: (kind, value) => observations.push({ kind, ...value }),
        addFailure: (value) => failures.push(value),
      });
      const request = fakeRequest({
        allHeaders: async () => ({ "content-type": "image/png" }),
        postData: () => null,
      });
      const bytes = Buffer.from([0, 1, 2, 255]);
      await page.emit("response", {
        request: () => request,
        url: () => "https://cdn.example.test/icon.png?cache=1",
        status: () => 200,
        allHeaders: async () => ({ "content-type": "image/png" }),
        body: async () => bytes,
      });
      await Promise.all(pending);

      const body = observations.find(item => item.kind === "http").body;
      expect(body.binary).toBe(true);
      expect(body.byteLength).toBe(bytes.length);
      expect(await readFile(body.artifact)).toEqual(bytes);
      expect(failures).toHaveLength(0);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("retains duplicate headers and complete binary bytes without an artifact directory", async () => {
    const page = fakePage();
    const records = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, { pending, record: (kind, data) => records.push({ kind, ...data }), addFailure: failure => failures.push(failure) });
    const headers = [{ name: "X-Diagnostic", value: "first" }, { name: "X-Diagnostic", value: "second" }];
    const request = fakeRequest({ headersArray: async () => headers, postData: () => null });
    const bytes = Buffer.from([0, 255, 128, 1]);
    page.emit("response", { request: () => request, url: request.url, status: () => 200, headersArray: async () => headers, body: async () => bytes });
    await drainPending(pending);
    const response = records.find(item => item.kind === "http");
    expect(response.headers).toEqual(headers);
    expect(response.requestHeaders).toEqual(headers);
    expect(Buffer.from(response.body.base64, "base64")).toEqual(bytes);
    expect(failures).toEqual([]);
  });

  it("lets the MSW event own mocked response bodies", async () => {
    const page = fakePage();
    const records = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      mockResponseBodiesOrigin: "https://api.stage.devneya.com",
      record: (kind, data) => records.push({ kind, ...data }),
      addFailure: failure => failures.push(failure),
    });
    const request = fakeRequest();
    const text = vi.fn(async () => "complete passthrough body");
    page.emit("response", { request: () => request, url: request.url, status: () => 200, fromServiceWorker: () => true, allHeaders: async () => ({}), text });
    await drainPending(pending);
    expect(text).not.toHaveBeenCalled();
    expect(records.find(item => item.kind === "mock-response-delegated")).toMatchObject({
      kind: "mock-response-delegated",
      responseId: { source: "playwright" },
      method: "POST",
      status: 200,
    });
    expect(JSON.stringify(records)).not.toContain("secret-token");
    captureMockResponse({
      kind: "response",
      requestId: "msw-request-1",
      method: "POST",
      url: request.url(),
      status: 200,
      body: '{"result":"complete"}',
    }, {
      record: (kind, data) => records.push({ kind, ...data }),
      addFailure: failure => failures.push(failure),
    });
    expect(records.find(item => item.kind === "http")).toMatchObject({
      kind: "http",
      responseId: { source: "msw", requestId: "msw-request-1" },
      body: { result: "complete" },
    });
    expect(missingResponseBodies(records)).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("redacts JSON credentials even when a provider labels the body as binary", async () => {
    const page = fakePage();
    const observations = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, {
      pending,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: (value) => failures.push(value),
    });
    const request = fakeRequest({
      allHeaders: async () => ({ "content-type": "application/octet-stream" }),
      postData: () => null,
    });
    await page.emit("response", {
      request: () => request,
      url: () => "https://api.stage.devneya.com/auth/token",
      status: () => 200,
      allHeaders: async () => ({ "content-type": "application/octet-stream" }),
      body: async () => Buffer.from(JSON.stringify({ password: "secret-password", ok: true })),
    });
    await Promise.all(pending);

    expect(observations.find(item => item.kind === "http").body).toEqual({ password: "[redacted]", ok: true });
    expect(JSON.stringify(observations)).not.toContain("secret-password");
    expect(failures).toHaveLength(0);
  });
});
