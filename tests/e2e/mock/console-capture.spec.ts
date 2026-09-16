import { expect, test } from "@playwright/test";
import { installConsoleCapture } from "../console-capture.mjs";
import { classifyLiveRun, installPageDiagnostics } from "../diagnostics.mjs";

test("retains a console message across navigation", async ({ page }) => {
  const calls: unknown[] = [];
  await installConsoleCapture(page, (payload) => calls.push(payload));

  await page.goto("/login");
  await page.evaluate(() => console.log("navigation-survival", { marker: "complete diagnostic value" }));
  await page.goto("/forgot-password");

  await expect.poll(() => JSON.stringify(calls)).toContain("navigation-survival");
  expect(JSON.stringify(calls)).toContain("complete diagnostic value");
});

test("retains the emitting origin after a cross-origin frame disappears", async ({ page }) => {
  const captures: unknown[] = [];
  const observations: unknown[] = [];
  const failures: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const consoleCapture = await installConsoleCapture(page, payload => captures.push(payload));
  const removeDiagnostics = installPageDiagnostics(page, {
    record: (kind, item) => observations.push({ kind, ...item }),
    addFailure: item => failures.push(item),
    pending,
    consoleSourceOrigins: consoleCapture.sourceOrigins,
  });

  await page.route("https://external.example.test/**", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    headers: {
      "content-security-policy": "default-src 'none'; script-src 'nonce-test'",
    },
    body: "<script nonce=\"test\">console.error('external detached', { marker: 'complete' }); parent.postMessage('remove', '*');</script>",
  }));
  await page.setContent(`
    <iframe src="https://external.example.test/frame"></iframe>
    <script>
      addEventListener('message', () => document.querySelector('iframe').remove());
    </script>
  `);
  await expect.poll(() => page.locator("iframe").count()).toBe(0);
  await Promise.allSettled(pending);
  removeDiagnostics();

  const result = classifyLiveRun({
    failures,
    firstPartyOrigins: ["http://127.0.0.1:4173"],
    cleanupStatus: "verified",
  });
  expect(failures.find(failure => (failure as { kind?: string }).kind === "console:error")).toMatchObject({
    consoleOrigin: "https://external.example.test",
    consoleOriginSource: "registered-document",
  });
  expect(result.workflowStatus).toBe("passed");
  expect(result.blockingFailures).toEqual([]);
  expect(result.thirdPartyDiagnostics.length).toBeGreaterThan(0);
  expect(JSON.stringify([...captures, ...observations])).toContain("external detached");
});
