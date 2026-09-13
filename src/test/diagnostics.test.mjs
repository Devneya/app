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
  safeBody,
  safeError,
  safeText,
  safeUrl,
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
      body: { collection_error: ["body unavailable"] },
    };
    expect(missingResponseBodies([complete, incomplete])).toEqual([expect.objectContaining({
      responseId: incomplete.responseId,
      captureSource: "playwright",
    })]);
    expect(missingResponseBodies([incomplete, complete])).toHaveLength(1);
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

    expect(observations.map(item => item.kind)).toEqual(["requestfailed"]);
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
  it("keeps third-party errors visible without making a verified live workflow fail", () => {
    const result = classifyLiveRun({
      requiredAssertions: ["checkout activates subscription"],
      assertions: [{ name: "checkout activates subscription", passed: true }],
      failures: [
        { kind: "http", url: "https://checkout.example.test/calculate", status: 403 },
        { kind: "console:error", location: { url: "https://checkout.example.test/sdk.js" } },
        { kind: "diagnostic-collection", operation: "response body", url: "https://checkout.example.test/calculate" },
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
    expect(records[0].requestBody.fields ?? records[0].requestBody).toEqual([
      { name: "value", contents: "first" }, { name: "value", contents: "second" }, { name: "password", contents: "[redacted]" },
    ]);
    expect(failures).toEqual([]);
  });

  it("reports an unfinished teardown read without blocking page closure", async () => {
    vi.useFakeTimers();
    let finish;
    const pending = [new Promise(resolve => { finish = resolve; })];
    try {
      const draining = drainBeforeClose(pending);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await draining;
      expect(result[0].status).toBe("rejected");
      expect(result[0].reason.message).toContain("teardown window");
      finish();
      expect((await drainPending(pending))[0].status).toBe("fulfilled");
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
    finishBody(body);
    await teardown;

    expect(pageClosed).toBe(true);
    expect(observations.find(item => item.kind === "http").body).toEqual({ captured: true });
    expect(observations.find(item => item.kind === "http").bodyCaptureComplete).toBe(true);
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
    expect(safeBody({ forterToken: "private-fraud-token", sessionId: "cks_private-session" })).toEqual({ forterToken: "[redacted]", sessionId: "[redacted-capability]" });
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

    expect(observations).toHaveLength(1);
    expect(observations[0].requestHeaders.collection_error.message).toContain("request headers unavailable");
    expect(observations[0].requestBody).toEqual({ password: "[redacted]", ok: true });
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("diagnostic-collection");
    expect(JSON.stringify(failures)).not.toContain("secret-token");
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

    expect(observations[0].body).toEqual({
      unavailable: true,
      reason: "Playwright does not expose response bodies for 3xx responses",
    });
    expect(observations[0].headers.location).toBe("/login/");
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

      const body = observations[0].body;
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
    expect(records[0].headers).toEqual(headers);
    expect(records[0].requestHeaders).toEqual(headers);
    expect(Buffer.from(records[0].body.base64, "base64")).toEqual(bytes);
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
    expect(records).toMatchObject([{
      kind: "mock-response-delegated",
      responseId: { source: "playwright" },
      method: "POST",
      status: 200,
    }]);
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
    expect(records).toMatchObject([{
      kind: "mock-response-delegated",
    }, {
      kind: "http",
      responseId: { source: "msw", requestId: "msw-request-1" },
      body: { result: "complete" },
    }]);
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

    expect(observations[0].body).toEqual({ password: "[redacted]", ok: true });
    expect(JSON.stringify(observations)).not.toContain("secret-password");
    expect(failures).toHaveLength(0);
  });
});
