import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import { MOCK_USER } from "../../src/mocks/data";
import {
  installPageDiagnostics,
  closeCapturedPage,
  configurePageCapture,
  MOCK_RESPONSE_CAPTURE_HOOK,
  captureMockResponse,
  missingResponseBodies,
  isAcceptedCaptureFailure,
  safeBody,
  safeError,
  trackPending,
} from "./diagnostics.mjs";

type DiagnosticFixtures = {
  browserDiagnostics: {
    observations: unknown[];
    failures: unknown[];
  };
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
      const recordMockedResponse = (payload: unknown) => captureMockResponse(payload, { record, addFailure });
      let testFailure: unknown;
      let configuration: Awaited<ReturnType<typeof configurePageCapture>> | undefined;
      try {
        configuration = await configurePageCapture(page, { record, addFailure, pending, binaryArtifactDir, captureBlobs: false });
        record("diagnostic-config", configuration);
      } catch (error) {
        const failure = {
          kind: "diagnostic-collection",
          operation: "configure browser capture",
          error: safeError(error),
          at: new Date().toISOString(),
        };
        failures.push(failure);
        testFailure = error;
      }
      if (!testFailure) {
        try {
          await page.exposeFunction(MOCK_RESPONSE_CAPTURE_HOOK, recordMockedResponse);
          record("diagnostic-config", { mswResponseCapture: "response:mocked binding" });
        } catch (error) {
          failures.push({
            kind: "diagnostic-collection",
            operation: "install MSW response capture binding",
            error: safeError(error),
            at: new Date().toISOString(),
          });
          testFailure = error;
        }
      }
      const removeDiagnostics = installPageDiagnostics(page, {
        record,
        addFailure,
        pending,
        binaryArtifactDir,
        mockResponseBodiesOrigin: new URL(testInfo.project.metadata.mockApiBaseUrl).origin,
        consoleSourceOrigins: configuration?.consoleSourceOrigins,
      });
      if (!testFailure) {
        try {
          await useFixture({ observations, failures });
        } catch (error) {
          testFailure ??= error;
        }
      }
      const expectedMockResponses = observations.filter((item) =>
        (item as { kind?: unknown }).kind === "mock-response-delegated"
      ).length;
      const mockDrain = page.evaluate(async (expectedCount) => {
        const drain = (globalThis as typeof globalThis & {
          __devneyaDrainMockResponses?: (expectedCount: number) => Promise<void>;
        }).__devneyaDrainMockResponses;
        if (drain) await drain(expectedCount);
      }, expectedMockResponses);
      trackPending(pending, "drain MSW mocked responses", mockDrain, {}, addFailure);
      const teardown = await closeCapturedPage({
        pending,
        removeDiagnostics,
        page,
        record,
        recordLifecycle: removeDiagnostics.recordLifecycle,
      });
      for (const { operation, error } of teardown.closeErrors) {
        const kind = operation === "close page" ? "page-close" :
          operation.startsWith("drain") ? "diagnostic-drain" : "diagnostic-collection";
        const failure = { kind, operation, error: safeError(error), at: new Date().toISOString() };
        failures.push(failure);
        testFailure ??= error;
      }
      for (const missing of missingResponseBodies(observations)) {
        addFailure({ kind: "diagnostic-collection", operation: "verify complete response body capture", ...missing,
          error: safeError(new Error("Browser response has no complete captured body.")) });
      }
      const rejected = teardown.drainResults.filter((result) => result.status === "rejected");
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
        captureStatus: failures.some(failure => {
          const item = failure as { kind?: unknown };
          return item.kind === "diagnostic-collection" || item.kind === "diagnostic-drain";
        }) ? "incomplete" : "complete",
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
        const item = failure as { kind?: unknown };
        return [
          "diagnostic-collection",
          "diagnostic-drain",
          "pageerror",
          "page-crash",
          "page-close",
        ].includes(item.kind as string) && !isAcceptedCaptureFailure(failure, failures, observations);
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

export { MOCK_USER };
