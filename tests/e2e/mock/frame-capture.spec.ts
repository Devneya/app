import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "../fixtures";

const BODY = Buffer.alloc(4 * 1024 * 1024, "b");

async function startFixture() {
  const server: Server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/parent") {
      const mode = url.searchParams.get("mode") ?? "complete";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><iframe src="http://localhost:${port}/child?mode=${mode}"></iframe>`);
      return;
    }
    if (url.pathname === "/child") {
      const mode = url.searchParams.get("mode") ?? "complete";
      const removeAfter = mode === "partial" ? 80 : 1000;
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><script>
        const source = '<!doctype html><script>fetch("http://localhost:${port}/blob-body").then(r => r.arrayBuffer()).catch(error => console.error("blob-body-fetch-failed", error));<\\/script>';
        setTimeout(() => {
          const frame = document.createElement('iframe');
          frame.src = URL.createObjectURL(new Blob([source], { type: 'text/html' }));
          document.body.append(frame);
          setTimeout(() => frame.remove(), ${removeAfter});
        }, 300);
      </script>`);
      return;
    }
    if (url.pathname === "/blob-body" || url.pathname === "/worker-body") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let offset = 0;
      const timer = setInterval(() => {
        if (offset === BODY.length) {
          clearInterval(timer);
          response.end();
          return;
        }
        const next = Math.min(offset + 128 * 1024, BODY.length);
        response.write(BODY.subarray(offset, next));
        offset = next;
      }, 10);
      request.on("close", () => clearInterval(timer));
      return;
    }
    if (url.pathname === "/worker") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body><script>
        const source = "self.onmessage = event => { if (event.data === 'start') self.postMessage('worker-ready'); if (event.data === 'fetch') fetch('http://127.0.0.1:${port}/worker-body').then(response => response.arrayBuffer()).then(() => self.postMessage('worker-body-complete')).catch(error => { console.error('worker-body-fetch-failed', error); self.postMessage('worker-body-failed'); }); };";
        const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        const worker = new Worker(url);
        worker.addEventListener('message', event => {
          if (event.data === 'worker-ready') worker.postMessage('fetch');
          if (event.data === 'worker-body-complete') {
            document.body.dataset.worker = 'body-complete';
            worker.terminate();
            URL.revokeObjectURL(url);
          }
        });
        worker.postMessage('start');
      </script>`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function findBody(observations: unknown[], path: string) {
  return observations.map(asRecord).find(item => item?.kind === "http" && String(item.url).includes(path) && item.captureSource === "cdp-stream");
}

function bodyArtifact(body: Record<string, unknown>) {
  const payload = asRecord(body.body);
  return String(payload?.artifact ?? "");
}

test("captures the complete body from a cross-origin blob iframe", async ({ page, browserDiagnostics }) => {
  const fixture = await startFixture();
  try {
    await page.goto(`${fixture.origin}/parent?mode=complete`);
    await expect.poll(() => asRecord(findBody(browserDiagnostics.observations, "/blob-body"))?.bodyCaptureComplete ?? false, { timeout: 15_000 }).toBe(true);
    const body = asRecord(findBody(browserDiagnostics.observations, "/blob-body"));
    expect(body?.availableBodyCaptureComplete).toBe(true);
    expect(asRecord(body?.body)?.byteLength).toBe(BODY.length);
    await expect(readFile(bodyArtifact(body ?? {}))).resolves.toEqual(BODY);
  } finally {
    await fixture.close();
  }
});

test("retains an aborted blob body prefix and the actual request failure", async ({ page, browserDiagnostics }) => {
  const fixture = await startFixture();
  try {
    await page.goto(`${fixture.origin}/parent?mode=partial`);
    await expect.poll(() => browserDiagnostics.observations.some(value => {
      const item = asRecord(value);
      return item?.kind === "requestfailed" && String(item.url).includes("/blob-body");
    }), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => {
      const body = asRecord(findBody(browserDiagnostics.observations, "/blob-body"));
      return body?.availableBodyCaptureComplete === true && body.bodyCaptureComplete === false;
    }, { timeout: 15_000 }).toBe(true);
    const body = asRecord(findBody(browserDiagnostics.observations, "/blob-body"));
    const bytes = await readFile(bodyArtifact(body ?? {}));
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes).toEqual(BODY.subarray(0, bytes.length));
    expect(browserDiagnostics.failures.some(value => {
      const item = asRecord(value);
      return item?.kind === "diagnostic-collection" && String(item.url).includes("/blob-body");
    })).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("captures a worker blob at creation before termination", async ({ page, browserDiagnostics }) => {
  const fixture = await startFixture();
  try {
    await page.goto(`${fixture.origin}/worker`);
    await expect(page.locator("body[data-worker='body-complete']")).toHaveCount(1);
    await expect.poll(() => browserDiagnostics.observations.some(value => {
      const item = asRecord(value);
      return item?.kind === "http" && String(item.url).includes("/worker-body") && item.captureSource === "cdp-stream" && item.bodyCaptureComplete === true;
    }), { timeout: 15_000 }).toBe(true);
    const source = browserDiagnostics.observations.map(asRecord).find(item => item?.kind === "blob-source");
    expect(source?.contentType).toBe("application/javascript");
    expect(JSON.stringify(source?.body)).toContain("worker-ready");
    const workerBody = asRecord(findBody(browserDiagnostics.observations, "/worker-body"));
    expect(asRecord(workerBody?.body)?.byteLength).toBe(BODY.length);
    await expect(readFile(bodyArtifact(workerBody ?? {}))).resolves.toEqual(BODY);
  } finally {
    await fixture.close();
  }
});
