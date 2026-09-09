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
    expect(output).toContain("TypeError: nested");
    expect(output).toContain("Error: first");
    expect(output).toContain('"status":502');
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
      text: () => "console capture failed",
      args: () => {
        throw new Error("console arguments unavailable");
      },
      location: () => ({}),
    });

    const settled = await drainPending(pending);
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("rejected");
    expect(failures[0].error.message).toContain("console arguments unavailable");
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

  it("configures uncached durable bodies through one reusable CDP setup", async () => {
    const calls = [];
    const session = {
      send: async (...args) => calls.push(args),
    };
    const page = {
      context: () => ({ newCDPSession: async () => session }),
    };

    await configurePageCapture(page);
    expect(calls).toEqual([
      ["Network.enable"],
      ["Network.setCacheDisabled", { cacheDisabled: true }],
      ["Network.configureDurableMessages", { maxTotalBufferSize: 8388608, maxResourceBufferSize: 2097152 }],
    ]);
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
