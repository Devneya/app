import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import {
  installPageDiagnostics,
  drainPending,
  safeBody,
  safeError,
} from "./diagnostics.mjs";

type DiagnosticFixtures = {
  browserDiagnostics: void;
};

export const test = base.extend<DiagnosticFixtures>({
  browserDiagnostics: [
    async ({ page }, useFixture, testInfo) => {
      const observations: unknown[] = [];
      const failures: unknown[] = [];
      const pending: Promise<unknown>[] = [];
      const binaryArtifactDir = testInfo.outputPath("browser-binary-responses");
      const record = (kind: string, value: unknown) => {
        const safeValue = safeBody(value);
        observations.push({ kind, ...(safeValue as Record<string, unknown>), at: new Date().toISOString() });
      };
      const addFailure = (value: unknown) => {
        const safeValue = safeBody(value);
        failures.push({ ...(safeValue as Record<string, unknown>), at: new Date().toISOString() });
      };
      installPageDiagnostics(page, { record, addFailure, pending, binaryArtifactDir });
      let testFailure: unknown;
      try {
        await useFixture();
      } catch (error) {
        testFailure = error;
      }
      const drainBeforeClose = await drainPending(pending);
      try {
        await page.close();
      } catch (error) {
        failures.push({
          kind: "page-close",
          error: safeError(error),
          at: new Date().toISOString(),
        });
        testFailure ??= error;
      }
      const drainAfterClose = await drainPending(pending);
      const drain = [...drainBeforeClose, ...drainAfterClose];
      const rejected = drain.filter((result) => result.status === "rejected");
      if (rejected.length) {
        failures.push({
          kind: "diagnostic-drain",
          errors: rejected.map((result) =>
            result.status === "rejected" ? safeError(result.reason) : undefined
          ),
          at: new Date().toISOString(),
        });
      }
      try {
        const binaryFiles = await readdir(binaryArtifactDir);
        for (const file of binaryFiles) {
          try {
            await testInfo.attach(`browser-${file}`, { path: join(binaryArtifactDir, file) });
          } catch (error) {
            failures.push({
              kind: "diagnostic-collection",
              operation: "attach binary response",
              file,
              error: safeError(error),
              at: new Date().toISOString(),
            });
            testFailure ??= error;
          }
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") {
          failures.push({
            kind: "diagnostic-collection",
            operation: "list binary response artifacts",
            error: safeError(error),
            at: new Date().toISOString(),
          });
          testFailure ??= error;
        }
      }
      const payload = safeBody({
        observations,
        failures,
        testFailure: testFailure ? safeError(testFailure) : undefined,
      });
      try {
        const diagnosticsPath = testInfo.outputPath("browser-diagnostics.json");
        await writeFile(diagnosticsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
        await testInfo.attach("browser-diagnostics", {
          path: diagnosticsPath,
          contentType: "application/json",
        });
      } catch (error) {
        const attachmentFailure = {
          kind: "diagnostic-collection",
          operation: "attach browser diagnostics",
          error: safeError(error),
          at: new Date().toISOString(),
        };
        failures.push(attachmentFailure);
        console.error(
          JSON.stringify(
            safeBody({
              kind: "browser-diagnostics-attachment-failure",
              payload: {
                observations,
                failures,
                testFailure: testFailure ? safeError(testFailure) : undefined,
              },
              attachmentFailure,
            }),
            null,
            2
          )
        );
        testFailure ??= error;
      }
      const hardFailures = failures.filter((failure) => {
        const item = failure as { kind?: unknown; expectedLifecycle?: unknown };
        return !item.expectedLifecycle && [
          "diagnostic-collection",
          "diagnostic-drain",
          "pageerror",
          "page-crash",
          "page-close",
        ].includes(item.kind as string);
      });
      if (hardFailures.length && !testFailure) {
        const error = new Error("Browser diagnostics collection or page execution failed.");
        error.cause = hardFailures;
        testFailure = error;
      }
      if (hardFailures.length || testFailure) {
        console.error(
          JSON.stringify(
            safeBody({
              kind: "browser-diagnostics",
              observations,
              failures,
              testFailure: testFailure ? safeError(testFailure) : undefined,
            }),
            null,
            2
          )
        );
      }
      if (testFailure) throw testFailure;
    },
    { auto: true },
  ],
});

export const MOCK_USER = {
  email: "demo@devneya.com",
  password: "password123",
};

export const MOCK_VIRTUAL_KEY =
  "sk-bf-mock-309eb063-af7c-4dae-8458-8a05868d2a98";

export const MOCK_CHECKOUT_URL =
  "https://checkout.dodopayments.com/session/mock-checkout-session";
