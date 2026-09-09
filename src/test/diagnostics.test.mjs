/* global Buffer */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurePageCapture,
  drainPending,
  drainBeforeClose,
  installPageDiagnostics,
  missingCdpStreamResponses,
  missingMockResponses,
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
  it("requires the exact blob source for every observed blob response", () => {
    const response = { kind: "http", method: "GET", url: "blob:private", status: 200,
      body: { captureSource: "blob-source", blobId: "exact-source" } };
    const source = { kind: "blob-source", blobId: "exact-source", body: "complete source" };
    expect(missingCdpStreamResponses([response])).toHaveLength(1);
    expect(missingCdpStreamResponses([response, { ...source, blobId: "different-source" }])).toHaveLength(1);
    expect(missingCdpStreamResponses([response, response, source])).toEqual([]);
  });
  it("detects missing original mock bodies and unmatched or duplicate source records", () => {
    const response = { kind: "http", method: "GET", url: "https://example.test/account", status: 200, body: { captureSource: "msw-response:mocked" } };
    const body = { ...response, body: "complete", captureSource: "msw-response:mocked" };
    expect(missingMockResponses([response, body])).toEqual([]);
    expect(missingMockResponses([response])).toMatchObject([{ observedResponses: 1, capturedBodies: 0 }]);
    expect(missingMockResponses([body])).toMatchObject([{ observedResponses: 0, capturedBodies: 1 }]);
    expect(missingMockResponses([response, response, body])).toMatchObject([{ observedResponses: 2, capturedBodies: 1 }]);
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

  it("configures uncached CDP streams through one reusable setup", async () => {
    const calls = [];
    const listeners = new Map();
    const session = {
      send: async (...args) => {
        calls.push(args);
        if (args[0] === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
        if (args[0] === "Network.streamResourceContent") return { bufferedData: "" };
        return {};
      },
      on: (event, listener) => listeners.set(event, listener),
      off: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    };
    const page = {
      context: () => ({ newCDPSession: async () => session }),
      exposeBinding: async () => {},
      addInitScript: async () => {},
    };

    const capture = await configurePageCapture(page, { record: () => {}, addFailure: () => {} });
    expect(calls).toEqual([
      ["Page.getFrameTree"],
      ["Network.enable"],
      ["Network.setCacheDisabled", { cacheDisabled: true }],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false,
        filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }] }],
    ]);
    expect(capture.cdpBodyCapture).toBe("streamResourceContent");
    capture.cdpStreams.close();
  });

  it("retains an invalid browser frame-tree result at the setup boundary", async () => {
    const result = { unexpected: "complete provider output" };
    const page = {
      context: () => ({ newCDPSession: async () => ({ send: async () => result }) }),
      exposeBinding: async () => {}, addInitScript: async () => {},
    };
    await expect(configurePageCapture(page, { record: () => {}, addFailure: () => {} }))
      .rejects.toMatchObject({ message: "Page.getFrameTree returned no root frame ID", cause: result });
  });

  it("captures a main-frame body from request-time CDP streaming", async () => {
    const page = fakePage();
    const calls = [];
    const listeners = new Map();
    const payload = Buffer.from(JSON.stringify({ status: "streamed" }));
    const session = {
      send: async (...args) => {
        calls.push(args);
        if (args[0] === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
        if (args[0] === "Network.streamResourceContent" && args[1].requestId === "request-3") {
          throw new Error("Request with the provided ID has already finished loading");
        }
        if (args[0] === "Network.getResponseBody" && args[1].requestId === "request-3") {
          return { body: JSON.stringify({ fallback: "complete" }), base64Encoded: false };
        }
        if (args[0] === "Network.streamResourceContent") return { bufferedData: payload.toString("base64") };
        return {};
      },
      on: (event, listener) => listeners.set(event, listener),
      off: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
      emit: (event, value) => listeners.get(event)?.(value),
    };
    page.context = () => ({ newCDPSession: async () => session });
    page.exposeBinding = async () => {};
    page.addInitScript = async () => {};
    const observations = [];
    const failures = [];
    const pending = [];
    const capture = await configurePageCapture(page, {
      pending,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: failure => failures.push(failure),
    });
    installPageDiagnostics(page, {
      pending,
      cdpStreams: capture.cdpStreams,
      record: (kind, value) => observations.push({ kind, ...value }),
      addFailure: failure => failures.push(failure),
    });
    session.emit("Network.requestWillBeSent", {
      requestId: "request-1",
      frameId: "root",
      request: { url: "https://api.example.test/account", method: "GET" },
    });
    session.emit("Network.responseReceived", {
      requestId: "request-1",
      response: { url: "https://api.example.test/account", status: 200, headers: { "content-type": "application/json" } },
    });
    session.emit("Network.loadingFinished", { requestId: "request-1", encodedDataLength: payload.length });
    const request = fakeRequest({
      method: () => "GET",
      url: () => "https://api.example.test/account",
      allHeaders: async () => ({}),
      postData: () => null,
    });
    await page.emit("response", {
      request: () => request,
      url: request.url,
      status: () => 200,
      resourceType: () => "fetch",
      frame: () => ({ parentFrame: () => null }),
      allHeaders: async () => ({ "content-type": "application/json" }),
      body: async () => { throw new Error("delayed Playwright body was used"); },
    });
    await drainPending(pending);
    const record = observations.find(item => item.kind === "http" && item.captureSource === "cdp-stream");
    expect(record.body).toEqual({ status: "streamed" });
    expect(record.captureSource).toBe("cdp-stream");
    expect(record.streamComplete).toBe(true);
    expect(observations.find(item => item.kind === "http" && item.body?.captureSource === "cdp-stream")).toBeTruthy();
    expect(missingCdpStreamResponses(observations)).toEqual([]);
    expect(failures).toEqual([]);
    expect(calls.some(([name]) => name === "Network.configureDurableMessages")).toBe(false);
    session.emit("Network.requestWillBeSent", {
      requestId: "request-2",
      frameId: "root",
      request: { url: "https://api.example.test/partial", method: "GET" },
    });
    session.emit("Network.responseReceived", {
      requestId: "request-2",
      response: { url: "https://api.example.test/partial", status: 200, headers: { "content-type": "application/json" } },
    });
    session.emit("Network.dataReceived", { requestId: "request-2", data: Buffer.from("partial").toString("base64") });
    session.emit("Network.loadingFailed", { requestId: "request-2", errorText: "local stream failure", canceled: false });
    const partialRequest = fakeRequest({
      method: () => "GET",
      url: () => "https://api.example.test/partial",
      allHeaders: async () => ({}),
      postData: () => null,
    });
    await page.emit("response", {
      request: () => partialRequest,
      url: partialRequest.url,
      status: () => 200,
      resourceType: () => "fetch",
      frame: () => ({ parentFrame: () => null }),
      allHeaders: async () => ({ "content-type": "application/json" }),
      body: async () => { throw new Error("delayed Playwright body was used"); },
    });
    await drainPending(pending);
    const partial = observations.find(item => item.kind === "http" && item.url.endsWith("/partial") && item.captureSource === "cdp-stream");
    expect(partial.streamComplete).toBe(false);
    expect(partial.bodyCaptureComplete).toBe(false);
    expect(partial.availableBodyCaptureComplete).toBe(true);
    expect(partial.cdpStream.errors[0].message).toContain("local stream failure");
    expect(failures.some(item => item.operation === "CDP response loading")).toBe(true);
    session.emit("Network.requestWillBeSent", {
      requestId: "request-3",
      frameId: "root",
      request: { url: "https://api.example.test/fallback", method: "GET" },
    });
    session.emit("Network.responseReceived", {
      requestId: "request-3",
      response: { url: "https://api.example.test/fallback", status: 200, headers: { "content-type": "application/json" } },
    });
    session.emit("Network.loadingFinished", { requestId: "request-3", encodedDataLength: 22 });
    const fallbackRequest = fakeRequest({
      method: () => "GET",
      url: () => "https://api.example.test/fallback",
      allHeaders: async () => ({}),
      postData: () => null,
    });
    await page.emit("response", {
      request: () => fallbackRequest,
      url: fallbackRequest.url,
      status: () => 200,
      resourceType: () => "fetch",
      frame: () => ({ parentFrame: () => null }),
      allHeaders: async () => ({ "content-type": "application/json" }),
      body: async () => { throw new Error("delayed Playwright body was used"); },
    });
    await drainPending(pending);
    const fallback = observations.find(item => item.kind === "http" && item.url.endsWith("/fallback") && item.captureSource === "cdp-stream");
    expect(fallback.body).toEqual({ fallback: "complete" });
    expect(fallback.streamComplete).toBe(false);
    expect(fallback.bodyCaptureComplete).toBe(true);
    expect(fallback.bodyCaptureMethod).toBe("Network.getResponseBody");
    expect(fallback.cdpStream.errors[0].message).toContain("already finished loading");
    expect(missingCdpStreamResponses(observations)).toEqual([]);
    capture.cdpStreams.close();
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

  it("uses the original mock body source only within its configured origin", async () => {
    const page = fakePage();
    const records = [];
    const failures = [];
    const pending = [];
    installPageDiagnostics(page, { pending, mockResponseBodiesOrigin: "https://api.stage.devneya.com", record: (kind, data) => records.push({ kind, ...data }), addFailure: failure => failures.push(failure) });
    const request = fakeRequest();
    const text = vi.fn(async () => "complete passthrough body");
    for (const url of [request.url(), "https://fonts.example.test/style.css"]) {
      page.emit("response", { request: () => request, url: () => url, status: () => 200, fromServiceWorker: () => true, allHeaders: async () => ({}), text });
    }
    await drainPending(pending);
    expect(records.find(record => record.url.startsWith("https://api.stage"))?.body).toEqual({ captureSource: "msw-response:mocked" });
    expect(records.find(record => record.url.startsWith("https://fonts"))?.body).toBe("complete passthrough body");
    expect(text).toHaveBeenCalledTimes(1);
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
