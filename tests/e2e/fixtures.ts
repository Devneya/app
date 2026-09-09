import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as base } from "@playwright/test";
import {
  installPageDiagnostics,
  drainPending,
  drainBeforeClose,
  configurePageCapture,
  MOCK_RESPONSE_CAPTURE_HOOK,
  missingMockResponses,
  missingCdpStreamResponses,
  safeBody,
  safeError,
  safeText,
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
      const recordMockedResponse = (payload: unknown) => {
        const data = payload && typeof payload === "object"
          ? payload as Record<string, unknown>
          : {};
        const context = {
          requestId: data.requestId,
          method: data.method,
          status: data.status,
          url: data.url,
        };
        if (data.kind === "error") {
          addFailure({
            kind: "diagnostic-collection",
            operation: "MSW mocked response",
            ...context,
            payload: data,
            error: safeError(data.error),
          });
          return;
        }
        if (
          data.kind !== "response" ||
          typeof data.requestId !== "string" ||
          typeof data.method !== "string" ||
          typeof data.url !== "string" ||
          !Number.isInteger(data.status) ||
          typeof data.body !== "string"
        ) {
          addFailure({
            kind: "diagnostic-collection",
            operation: "MSW mocked response",
            ...context,
            error: safeError(new Error("MSW mocked response capture payload omitted response metadata or body.")),
            payload: data,
          });
          return;
        }
        let body: unknown;
        try {
          body = safeBody(JSON.parse(data.body));
        } catch {
          body = safeText(data.body);
        }
        record("http", {
          ...context,
          headers: safeBody(data.headers),
          body,
          fromServiceWorker: true,
          captureSource: "msw-response:mocked",
        });
      };
      let testFailure: unknown;
      let cdpStreams: Awaited<ReturnType<typeof configurePageCapture>>["cdpStreams"] | undefined;
      try {
        const configured = await configurePageCapture(page, { record, addFailure, pending, binaryArtifactDir });
        const { cdpStreams: streams, ...configuration } = configured;
        cdpStreams = streams;
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
        cdpStreams,
      });
      if (!testFailure) {
        try {
          await useFixture();
        } catch (error) {
          testFailure ??= error;
        }
      }
      const mockDrain = page.evaluate(async () => {
        const drain = (globalThis as typeof globalThis & {
          __devneyaDrainMockResponses?: () => Promise<void>;
        }).__devneyaDrainMockResponses;
        if (drain) await drain();
      });
      pending.push(mockDrain);
      mockDrain.catch((error) => addFailure({
        kind: "diagnostic-collection",
        operation: "drain MSW mocked responses",
        error: safeError(error),
      }));
      const beforeClose = await drainBeforeClose(pending);
      try {
        removeDiagnostics();
      } catch (error) {
        failures.push({
          kind: "diagnostic-collection",
          operation: "remove page diagnostics listeners",
          error: safeError(error),
          at: new Date().toISOString(),
        });
        testFailure ??= error;
      }
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
      try {
        cdpStreams?.close();
      } catch (error) {
        addFailure({ kind: "diagnostic-collection", operation: "close CDP response streams", error: safeError(error) });
        testFailure ??= error;
      }
      const drainAfterClose = await drainPending(pending);
      for (const missing of missingCdpStreamResponses(observations)) {
        addFailure({ kind: "diagnostic-collection", operation: "verify complete CDP response capture", ...missing,
          error: safeError(new Error("Browser response has no complete captured CDP stream.")) });
      }
      for (const missing of missingMockResponses(observations)) {
        addFailure({
          kind: "diagnostic-collection",
          operation: "verify complete MSW response capture",
          ...missing,
          error: safeError(new Error("Mocked browser responses and captured original bodies do not match.")),
        });
      }
      const drain = [...beforeClose, ...drainAfterClose];
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
        const item = failure as { kind?: unknown };
        return [
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
