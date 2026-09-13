import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import {
  classifyLiveRun,
  closeCapturedPage,
  installPageDiagnostics,
  installSubscribeResponseCapture,
  missingResponseBodies,
  safeBody,
} from "../diagnostics.mjs";

type LocalServer = { origin: string; close: () => Promise<void> };

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test server did not bind a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function recordSafely(target: unknown[], kind: string, value: unknown) {
  target.push({ kind, ...(safeBody(value) as Record<string, unknown>) });
}

test("captures exact Subscribe response bodies before immediate checkout navigation", async ({ page }) => {
  const submitted: string[] = [];
  let pingCount = 0;
  const api = await listen((request, response) => {
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/account/subscribe" && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const marker = (JSON.parse(body) as { marker: string }).marker;
        submitted.push(marker);
        response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
          marker,
          checkout_url: `https://checkout.example.test/${marker}-private-capability`,
        }));
      });
      return;
    }
    if (request.url === "/ping") {
      pingCount += 1;
      response.writeHead(204).end();
      return;
    }
    if (request.url?.startsWith("/checkout")) {
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Checkout</title>");
      return;
    }
    response.writeHead(404).end();
  });
  const app = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><script>
      (async () => {
        await fetch(${JSON.stringify(`${api.origin}/ping`)});
        const results = await Promise.all(["first", "second"].map(async marker => {
          const response = await fetch(${JSON.stringify(`${api.origin}/account/subscribe`)}, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marker })
          });
          return response.json();
        }));
        location.href = ${JSON.stringify(`${api.origin}/checkout?seen=`)} + results.map(result => result.marker).join(",");
      })();
    </script>`);
  });
  const appOrigin = app.origin;
  const observations: unknown[] = [];
  const failures: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const record = (kind: string, value: unknown) => recordSafely(observations, kind, value);
  const addFailure = (value: unknown) => failures.push(safeBody(value));
  let removeDiagnostics = () => {};
  let removeRoute: (() => Promise<void>) | undefined;

  try {
    const routeCapture = await installSubscribeResponseCapture(page, { apiOrigin: api.origin, addFailure, pending });
    removeRoute = routeCapture.remove;
    removeDiagnostics = installPageDiagnostics(page, {
      record,
      addFailure,
      pending,
      responseBodies: routeCapture.responseBodies,
    });
    await page.goto(appOrigin);
    await page.waitForURL(url => url.origin === api.origin && url.pathname === "/checkout" && url.searchParams.get("seen") === "first,second");
    const teardown = await closeCapturedPage({
      pending,
      page,
      removeDiagnostics: async () => {
        removeDiagnostics();
        await removeRoute?.();
      },
    });

    const subscribeResponses = (observations as Array<Record<string, unknown>>).filter(item =>
      item.kind === "http" && item.url === `${api.origin}/account/subscribe`);
    expect(submitted).toEqual(["first", "second"]);
    expect(pingCount).toBe(1);
    expect(subscribeResponses).toHaveLength(2);
    expect(new Set(subscribeResponses.map(item => JSON.stringify(item.responseId))).size).toBe(2);
    expect(subscribeResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 201,
        captureSource: "playwright-route-fetch",
        bodyCaptureComplete: true,
        body: { marker: "first", checkout_url: "[redacted]" },
      }),
      expect.objectContaining({
        status: 201,
        captureSource: "playwright-route-fetch",
        bodyCaptureComplete: true,
        body: { marker: "second", checkout_url: "[redacted]" },
      }),
    ]));
    expect(missingResponseBodies(observations as Array<Record<string, unknown>>)).toEqual([]);
    expect(JSON.stringify(observations)).not.toContain("private-capability");
    expect(failures.filter(value => (value as { kind?: string }).kind === "diagnostic-collection")).toEqual([]);
    expect(teardown.closeErrors).toEqual([]);
    expect(teardown.drainResults.filter(result => result.status === "rejected")).toEqual([]);
  } finally {
    removeDiagnostics();
    await removeRoute?.();
    await page.close().catch(() => {});
    await Promise.all([app.close(), api.close()]);
  }
});

test("classifies console errors by their document origin when a third-party script runs in the app", async ({ page }) => {
  const external = await listen((request, response) => {
    if (request.url === "/external.js") {
      response.writeHead(200, { "content-type": "application/javascript" })
        .end('console.error("external script in first-party document");');
      return;
    }
    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html" })
        .end('<!doctype html><script>console.error("third-party iframe document");</script>');
      return;
    }
    response.writeHead(404).end();
  });
  const app = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html>
      <script src="${external.origin}/external.js"></script>
      <iframe src="${external.origin}/frame"></iframe>`);
  });
  const observations: unknown[] = [];
  const failures: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const record = (kind: string, value: unknown) => recordSafely(observations, kind, value);
  const addFailure = (value: unknown) => failures.push(safeBody(value));
  const removeDiagnostics = installPageDiagnostics(page, { record, addFailure, pending });
  try {
    await page.goto(app.origin);
    await expect.poll(() => (observations as Array<Record<string, unknown>>)
      .filter(item => item.kind === "console").length).toBeGreaterThanOrEqual(2);
    await Promise.all(pending);

    const consoleErrors = (failures as Array<Record<string, unknown>>).filter(item => item.kind === "console:error");
    const scriptError = consoleErrors.find(item => item.text === "external script in first-party document");
    const frameError = consoleErrors.find(item => item.text === "third-party iframe document");
    expect(scriptError).toMatchObject({
      consoleOriginSource: "document-context",
      location: { url: `${external.origin}/external.js` },
    });
    expect(new URL(String(scriptError?.consoleOrigin)).origin).toBe(app.origin);
    expect(frameError).toMatchObject({
      consoleOriginSource: "document-context",
    });
    expect(new URL(String(frameError?.consoleOrigin)).origin).toBe(external.origin);

    const result = classifyLiveRun({
      requiredAssertions: ["both console events attributed"],
      assertions: [{ name: "both console events attributed", passed: true }],
      failures: consoleErrors,
      cleanupStatus: "verified",
      firstPartyOrigins: [app.origin],
    });
    expect(result.blockingFailures).toEqual([scriptError]);
    expect(result.thirdPartyDiagnostics).toEqual([frameError]);
  } finally {
    const teardown = await closeCapturedPage({ pending, removeDiagnostics, page });
    await Promise.all([app.close(), external.close()]);
    expect(teardown.closeErrors).toEqual([]);
  }
});
