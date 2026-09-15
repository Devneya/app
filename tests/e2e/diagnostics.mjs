/* global Buffer, Headers, Response, TextDecoder, URL, URLSearchParams */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installConsoleCapture } from "./console-capture.mjs";
import { installBlobCapture } from "./blob-capture.mjs";

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function responseBytes(value) {
  if (value && Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return Buffer.from(value);
  }
  if (value && ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

export function safeUrl(value) {
  return String(value);
}

export function safeText(value) {
  return String(value);
}

export function safeError(error, seen = new WeakSet()) {
  if (error instanceof Error) {
    if (seen.has(error)) return { message: "[circular-error]" };
    seen.add(error);
    try {
    const output = {
      name: String(error.name || "Error"),
      message: String(error.message || String(error)),
      stack: String(error.stack || ""),
    };
    if (typeof AggregateError !== "undefined" && error instanceof AggregateError && Array.isArray(error.errors)) {
      output.errors = error.errors.map((item) => (isObject(item) ? safeError(item, seen) : { message: String(item) }));
    }
    if ("cause" in error && error.cause !== undefined) {
      output.cause = isObject(error.cause)
        ? safeError(error.cause, seen)
        : { message: String(error.cause) };
    }
    for (const [key, value] of Object.entries(error)) {
      if (key === "cause" || Object.hasOwn(output, key)) continue;
      Object.defineProperty(output, key, {
        value: safeBody(value, seen),
        enumerable: true,
      });
    }
    return output;
    } finally {
      seen.delete(error);
    }
  }
  if (isObject(error)) {
    return { name: "Error", message: String(error.message ?? String(error)), details: safeBody(error, seen) };
  }
  return { name: "Error", message: String(error), stack: "" };
}

export function safeBody(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;
  if (value instanceof Error) return safeError(value, seen);
  if (value instanceof URL) return value.href;
  if (value instanceof Headers) return safeHeaders(value, seen);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
  if (Array.isArray(value)) return value.map((item) => safeBody(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const outputKey = key;
    let outputKeyCandidate = outputKey;
    let duplicate = 2;
    while (Object.hasOwn(output, outputKeyCandidate)) outputKeyCandidate = `${outputKey} [duplicate ${duplicate++}]`;
    Object.defineProperty(output, outputKeyCandidate, {
      value: safeBody(item, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
  } finally {
    seen.delete(value);
  }
}

export function safeHeaders(value, seen = new WeakSet()) {
  if (value && typeof value.entries === "function") {
    if (Array.isArray(value)) return safeBody(value, seen);
    return safeBody(Object.fromEntries(value.entries()), seen);
  }
  return safeBody(value, seen);
}

function contentTypeOf(headers) {
  if (Array.isArray(headers)) return headers.find(header => header.name.toLowerCase() === "content-type")?.value ?? "";
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
}

function readHeaders(message) {
  return typeof message.headersArray === "function" ? message.headersArray() : message.allHeaders();
}

async function requestBody(request, requestHeaders) {
  const postData = request.postData();
  if (postData === null) return undefined;
  const contentType = contentTypeOf(requestHeaders);
  if (
    contentType.toLowerCase().includes("multipart/form-data") ||
    /content-disposition:\s*form-data/i.test(postData)
  ) {
    const type = contentType || `multipart/form-data; boundary=${postData.split("\r\n", 1)[0].slice(2)}`;
    const raw = typeof request.postDataBuffer === "function" ? request.postDataBuffer() : postData;
    const form = await new Response(raw, { headers: { "content-type": type } }).formData();
    const fields = [];
    for (const [name, value] of form) {
      if (typeof value === "string") {
        fields.push({ name, contents: safeBody({ [name]: value })[name] });
      } else {
        const bytes = Buffer.from(await value.arrayBuffer());
        let contents;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          try { contents = safeBody(JSON.parse(text)); } catch { contents = safeText(text); }
        } catch {
          contents = { base64: bytes.toString("base64"), byteLength: bytes.byteLength };
        }
        fields.push({ name, filename: safeText(value.name), contentType: value.type, contents });
      }
    }
    return { multipart: true, fields };
  }
  if (contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return [...new URLSearchParams(postData)].map(([name, value]) => ({
      name, contents: safeBody({ [name]: value })[name],
    }));
  }
  try {
    return safeBody(JSON.parse(postData));
  } catch {
    return safeText(postData);
  }
}

async function collect(label, read, context, addFailure) {
  try {
    return await read();
  } catch (error) {
    const detail = {
      kind: "diagnostic-collection",
      operation: label,
      ...context,
      error: safeError(error),
    };
    if (
      context.fromServiceWorker === true &&
      label === "response body" &&
      /No resource with given identifier found/i.test(error?.message ?? "")
    ) {
      detail.expectedLifecycle = true;
    }
    addFailure(detail);
    return { collection_error: detail.error };
  }
}

const pendingTaskDetails = new WeakMap();

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function snapshotPendingOperations(pending) {
  return pending.flatMap((task, index) => {
    const details = pendingTaskDetails.get(task);
    if (!details || details.settled) return [];
    return [{
      operation: details.operation,
      index,
      ...details.context,
      startedAt: details.startedAt,
      elapsedMs: Math.max(0, Math.round(monotonicNow() - details.startedMonotonicMs)),
      ...(details.evidenceSnapshot ? { evidence: safeBody(details.evidenceSnapshot()) } : {}),
    }];
  });
}

export function trackPending(pending, operation, task, context, addFailure, { evidenceSnapshot } = {}) {
  const tracked = Promise.resolve(task);
  const details = {
    operation,
    context: safeBody(context ?? {}),
    startedAt: new Date().toISOString(),
    startedMonotonicMs: monotonicNow(),
    evidenceSnapshot,
    settled: false,
  };
  pendingTaskDetails.set(tracked, details);
  tracked.then(
    () => { details.settled = true; },
    () => { details.settled = true; },
  );
  tracked.catch((error) => {
    addFailure({
      kind: "diagnostic-collection",
      operation,
      ...safeBody(context ?? {}),
      error: safeError(error),
    });
  });
  pending.push(tracked);
  return tracked;
}

const track = trackPending;

export async function drainPending(pending) {
  const settled = [];
  let drained = 0;
  while (drained < pending.length) {
    const batch = pending.slice(drained);
    const start = drained;
    settled.push(...(await Promise.allSettled(batch)).map((result, index) => ({
      ...result,
      taskIndex: start + index,
    })));
    drained += batch.length;
  }
  return settled;
}

export async function configurePageCapture(
  page,
  { record, addFailure, pending = [], binaryArtifactDir, captureBlobs = false } = {},
) {
  await installConsoleCapture(page, payload => {
    const safe = safeBody(payload);
    record("console-call", safe);
    if (payload.kind !== "console-call") {
      addFailure({ kind: "diagnostic-collection", operation: "console source snapshot", ...safe });
    }
  });
  if (captureBlobs) {
    let blobSequence = 0;
    await installBlobCapture(page, payload => track(pending, "blob source capture", (async () => {
      if (payload.error) {
        addFailure({ kind: "diagnostic-collection", operation: "blob source capture", url: safeUrl(payload.url), error: safeBody(payload.error) });
        return;
      }
      const serialized = await serializeResponseBody(Buffer.from(payload.base64, "base64"),
        { "content-type": payload.contentType }, { url: safeUrl(payload.url) }, {
          binaryArtifactDir, binaryPrefix: "blob-source", nextBinaryArtifact: () => ++blobSequence, addFailure,
        });
      record("blob-source", { blobId: createHash("sha256").update(payload.url).digest("hex"),
        url: safeUrl(payload.url), contentType: payload.contentType, body: serialized.body });
    })(), { url: safeUrl(payload.url) }, addFailure));
  }
  return {
    responseBodyCapture: captureBlobs
      ? "Playwright response bodies; MSW owns mocked bodies; blob bytes captured at creation"
      : "Playwright response bodies; MSW owns mocked bodies",
  };
}

export async function installSubscribeResponseCapture(
  page,
  { apiOrigin, addFailure, pending = [] } = {},
) {
  const expectedOrigin = new URL(apiOrigin).origin;
  const responseBodies = new WeakMap();
  const matches = url => {
    try {
      return url.origin === expectedOrigin && url.pathname === "/account/subscribe";
    } catch {
      return false;
    }
  };
  const handler = async route => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }

    let resolveCapture;
    const capturePromise = new Promise(resolve => { resolveCapture = resolve; });
    responseBodies.set(request, capturePromise);
    const captureTask = (async () => {
      let upstream;
      try {
        upstream = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        const capture = {
          ok: true,
          status: upstream.status(),
          headers: upstream.headers(),
          bytes: await upstream.body(),
        };
        await route.fulfill({ response: upstream });
        resolveCapture(capture);
      } catch (error) {
        resolveCapture({ ok: false, error });
        addFailure({
          kind: "diagnostic-collection",
          operation: "subscription response route",
          method: request.method(),
          url: safeUrl(request.url()),
          error: safeError(error),
        });
        try {
          await route.abort();
        } catch (abortError) {
          addFailure({
            kind: "diagnostic-collection",
            operation: "abort failed subscription response route",
            method: request.method(),
            url: safeUrl(request.url()),
            error: safeError(abortError),
          });
        }
      } finally {
        if (upstream) {
          try {
            await upstream.dispose();
          } catch (error) {
            addFailure({
              kind: "diagnostic-collection",
              operation: "release subscription response route",
              method: request.method(),
              url: safeUrl(request.url()),
              error: safeError(error),
            });
          }
        }
      }
    })();
    trackPending(pending, "subscription response route", captureTask, {
      url: safeUrl(request.url()),
      method: request.method(),
    }, addFailure);
    await captureTask;
  };
  const routeMatcher = url => matches(url);
  await page.route(routeMatcher, handler);
  let installed = true;
  return {
    responseBodies,
    remove: async () => {
      if (!installed) return;
      installed = false;
      await page.unroute(routeMatcher, handler);
    },
  };
}

export async function drainBeforeClose(pending) {
  let timer;
  try {
    return await Promise.race([
      drainPending(pending),
      new Promise(resolve => {
        timer = globalThis.setTimeout(() => resolve([{
          status: "rejected",
          reason: Object.assign(
            new Error("Browser capture exceeded the five-second teardown window; close the page and retain remaining reader errors."),
            {
              pendingOperations: snapshotPendingOperations(pending),
            },
          ),
        }]), 5000);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function closeCapturedPage({ pending = [], removeDiagnostics, page, record, recordLifecycle } = {}) {
  const settledTasks = new Map();
  const drainTimeouts = [];
  const closeErrors = [];
  const note = (phase, details = {}) => {
    try {
      const item = { phase, ...details };
      if (recordLifecycle) {
        recordLifecycle("capture-shutdown", item);
      } else {
        record?.("capture-shutdown", {
          ...item,
          eventAt: new Date().toISOString(),
          eventMonotonicMs: monotonicNow(),
        });
      }
    } catch (error) {
      closeErrors.push({ operation: `record capture shutdown ${phase}`, error });
    }
  };
  const pendingSnapshot = () => snapshotPendingOperations(pending);
  const drain = async operation => {
    try {
      const results = await drainBeforeClose(pending);
      for (const result of results) {
        if (Number.isInteger(result.taskIndex)) settledTasks.set(result.taskIndex, result);
        else drainTimeouts.push({ ...result, phase: operation });
      }
    } catch (error) {
      closeErrors.push({ operation, error });
    }
  };
  const attempt = async (operation, action) => {
    try {
      await action?.();
      return true;
    } catch (error) {
      closeErrors.push({ operation, error });
      return false;
    }
  };

  note("drain-before-close-started", { pendingOperations: pendingSnapshot() });
  await drain("drain before capture shutdown");
  note("drain-before-close-finished", {
    pendingOperations: pendingSnapshot(),
    timedOut: drainTimeouts.length > 0,
  });
  note("diagnostic-listener-removal-started");
  const listenersRemoved = await attempt("remove page diagnostics listeners", removeDiagnostics);
  note(listenersRemoved ? "diagnostic-listeners-removed" : "diagnostic-listener-removal-failed", {
    ...(!listenersRemoved ? { error: safeError(closeErrors.at(-1)?.error) } : {}),
  });
  note("page-close-requested", { pendingOperations: pendingSnapshot() });
  const pageClosed = page ? await attempt("close page", () => page.close()) : undefined;
  note(pageClosed === true ? "page-close-completed" : pageClosed === false ? "page-close-failed" : "page-close-not-opened", {
    ...(pageClosed === false ? { error: safeError(closeErrors.at(-1)?.error) } : {}),
  });
  await drain("drain after page close");
  note("post-close-drain-finished", {
    pendingOperations: pendingSnapshot(),
    timedOut: drainTimeouts.length > 0,
  });
  const drainResults = [...settledTasks.values(), ...drainTimeouts].map(result =>
    Object.fromEntries(Object.entries(result).filter(([key]) => key !== "taskIndex"))
  );
  return { drainResults, closeErrors };
}

export const MOCK_RESPONSE_CAPTURE_HOOK = "__devneyaCaptureMockResponse";

export function captureMockResponse(payload, { record, addFailure }) {
  const data = payload && typeof payload === "object"
    ? payload
    : {};
  const responseId = typeof data.requestId === "string"
    ? { source: "msw", requestId: data.requestId }
    : undefined;
  const context = {
    ...(responseId ? { responseId } : {}),
    requestId: data.requestId,
    method: data.method,
    status: data.status,
    url: typeof data.url === "string" ? safeUrl(data.url) : data.url,
  };
  if (data.kind === "error") {
    addFailure({
      kind: "diagnostic-collection",
      operation: "MSW mocked response",
      ...context,
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
    });
    return;
  }
  let body;
  try {
    body = safeBody(JSON.parse(data.body));
  } catch {
    body = safeText(data.body);
  }
  record("http", {
    ...context,
    headers: safeBody(data.headers),
    body,
    bodyCaptureStatus: "complete",
    fromServiceWorker: true,
    captureSource: "msw-response:mocked",
  });
}

export function missingResponseBodies(observations) {
  const blobIds = new Set(observations
    .filter(item => item?.kind === "blob-source")
    .map(item => item.blobId));
  const missingBlobs = [];
  const seenBlobResponses = new Set();
  for (const item of observations.filter(item =>
    item?.kind === "http" && item.body?.captureSource === "blob-source" && !blobIds.has(item.body.blobId))) {
    const key = item.responseId?.source === "playwright" && typeof item.responseId.requestId === "string"
      ? item.responseId.requestId
      : JSON.stringify([item.body.blobId, item.url]);
    if (seenBlobResponses.has(key)) continue;
    seenBlobResponses.add(key);
    missingBlobs.push({
      responseId: item.responseId,
      ...(item.frameId ? { frameId: item.frameId } : {}),
      method: item.method,
      url: item.url,
      status: item.status,
      captureSource: "blob-source",
    });
  }

  const incompleteResponses = [];
  const seenResponseIds = new Set();
  for (const item of observations.filter(item =>
    item?.kind === "http" && item.responseId?.source === "playwright")) {
    const requestId = item.responseId.requestId;
    if (seenResponseIds.has(requestId)) continue;
    seenResponseIds.add(requestId);
    const status = item.bodyCaptureStatus ?? "incomplete";
    if (["complete", "bodyless", "referenced", "delegated"].includes(status)) continue;
    incompleteResponses.push({
      responseId: item.responseId,
      ...(item.frameId ? { frameId: item.frameId } : {}),
      method: item.method,
      url: item.url,
      status: item.status,
      captureSource: item.captureSource ?? "playwright",
      bodyCaptureStatus: status,
      ...(item.bodyCompletenessReason ? { bodyCompletenessReason: item.bodyCompletenessReason } : {}),
      ...(item.bodyCaptured ? { bodyCaptured: true } : {}),
      ...(item.body !== undefined ? { body: item.body } : {}),
    });
  }

  const mockResponseKey = item => JSON.stringify([item.method, item.url, item.status]);
  const delegatedMockResponses = observations.filter(item => item?.kind === "mock-response-delegated");
  const capturedMockResponses = observations.filter(item =>
    item?.kind === "http" && item.captureSource === "msw-response:mocked" && item.bodyCaptureStatus === "complete");
  const delegatedByKey = new Map();
  const capturedCounts = new Map();
  for (const item of delegatedMockResponses) {
    const key = mockResponseKey(item);
    delegatedByKey.set(key, [...(delegatedByKey.get(key) ?? []), item]);
  }
  for (const item of capturedMockResponses) {
    const key = mockResponseKey(item);
    capturedCounts.set(key, (capturedCounts.get(key) ?? 0) + 1);
  }
  const mockMismatches = [];
  for (const [key, delegated] of delegatedByKey) {
    const missingCount = delegated.length - (capturedCounts.get(key) ?? 0);
    for (const item of delegated.slice(0, Math.max(0, missingCount))) {
      mockMismatches.push({
        responseId: item.responseId,
        method: item.method,
        url: item.url,
        status: item.status,
        captureSource: "msw-response:mocked",
      });
    }
  }
  const delegatedCounts = new Map([...delegatedByKey].map(([key, items]) => [key, items.length]));
  for (const [key, capturedCount] of capturedCounts) {
    const extraCount = capturedCount - (delegatedCounts.get(key) ?? 0);
    if (extraCount <= 0) continue;
    const matching = capturedMockResponses.filter(item => mockResponseKey(item) === key);
    for (const item of matching.slice(-extraCount)) {
      mockMismatches.push({
        responseId: item.responseId,
        method: item.method,
        url: item.url,
        status: item.status,
        captureSource: "msw-response:mocked-unmatched",
      });
    }
  }
  const seenMockRequestIds = new Set();
  for (const item of capturedMockResponses) {
    const requestId = item.responseId?.requestId;
    if (typeof requestId !== "string") continue;
    if (seenMockRequestIds.has(requestId)) {
      mockMismatches.push({
        responseId: item.responseId,
        method: item.method,
        url: item.url,
        status: item.status,
        captureSource: "msw-response:mocked-duplicate",
      });
    } else {
      seenMockRequestIds.add(requestId);
    }
  }
  return [...missingBlobs, ...incompleteResponses, ...mockMismatches];
}

function samePlaywrightResponse(first, second) {
  return first?.source === "playwright" && second?.source === "playwright" &&
    typeof first.requestId === "string" && first.requestId === second.requestId;
}

export function isAcceptedCaptureFailure(failure, failures = [], observations = []) {
  if (failure?.kind !== "diagnostic-collection") return false;
  const bodyReadFailure = failure.operation === "response body"
    ? failure
    : failures.find(other =>
      other?.kind === "diagnostic-collection" && other.operation === "response body" &&
      samePlaywrightResponse(failure.responseId, other.responseId) &&
      other.frameId === failure.frameId &&
      /No data found for resource with given identifier/i.test(other.error?.message ?? ""));
  const responseBodyReadFailed = bodyReadFailure &&
    /No data found for resource with given identifier/i.test(bodyReadFailure.error?.message ?? "");
  if (failure.operation === "response body" && failure.method === "OPTIONS" &&
      /No data found for resource with given identifier/i.test(failure.error?.message ?? "")) {
    return true;
  }
  const isOptionsVerification = failure.operation === "verify complete response body capture" &&
    failure.method === "OPTIONS" && failures.some(other =>
      other?.kind === "diagnostic-collection" && other.operation === "response body" &&
      other.method === "OPTIONS" && samePlaywrightResponse(failure.responseId, other.responseId) &&
      /No data found for resource with given identifier/i.test(other.error?.message ?? ""));
  if (isOptionsVerification) return true;
  if (!["response body", "verify complete response body capture"].includes(failure.operation)) return false;
  const requestWasAborted = failures.some(other =>
    other?.kind === "requestfailed" && samePlaywrightResponse(failure.responseId, other.responseId) &&
    other.error === "net::ERR_ABORTED" && typeof failure.frameId === "string" &&
    other.frameId === failure.frameId);
  const readFailureAt = Date.parse(bodyReadFailure?.at ?? "");
  const frameDisappearedDuringRead = typeof failure.frameId === "string" && observations.some(other => {
    if (other?.kind !== "frame-detached" || other.frameId !== failure.frameId) return false;
    if (Number.isInteger(other.diagnosticOrder) && Number.isInteger(bodyReadFailure?.diagnosticOrder)) {
      return other.diagnosticOrder < bodyReadFailure.diagnosticOrder;
    }
    return Number.isFinite(readFailureAt) && Number.isFinite(Date.parse(other.at ?? "")) &&
      Date.parse(other.at) < readFailureAt;
  });
  return responseBodyReadFailed && requestWasAborted && frameDisappearedDuringRead;
}

export function isConsoleCopyOfExpectedHttpFailure(failure, failures = [], expectedHttpFailure = () => false) {
  if (failure?.kind !== "console:error" ||
      failure.text !== "Failed to load resource: the server responded with a status of 403 ()" ||
      typeof failure.location?.url !== "string") return false;
  return failures.some(other =>
    other?.kind === "http" && other.url === failure.location.url && expectedHttpFailure(other));
}

export function classifyLiveRun({
  requiredAssertions = [],
  assertions = [],
  failures = [],
  observations = [],
  cleanupStatus,
  firstPartyOrigins = [],
  acceptedCaptureFailure = () => false,
  expectedHttpFailure = () => false,
  expectedConsoleFailure = () => false,
  evidenceWriteFailed = false,
}) {
  const origins = new Set(firstPartyOrigins.map(origin => {
    try {
      return new URL(origin).origin;
    } catch {
      return "";
    }
  }).filter(Boolean));
  const blockingFailures = [];
  const thirdPartyDiagnostics = [];
  const acceptedCaptureFailures = [];
  const expectedHttpFailures = [];
  const expectedConsoleFailures = [];
  const warnings = [];
  const failedAssertions = assertions.filter(assertion => assertion.passed !== true);
  const missingAssertions = requiredAssertions.filter(name =>
    !assertions.some(assertion => assertion.name === name && assertion.passed === true)
  );
  let captureIncomplete = false;

  for (const failure of failures) {
    const kind = failure.failureKind ?? failure.kind;
    if (kind === "console:warning") {
      warnings.push(failure);
      continue;
    }
    if (kind?.startsWith("console:") && expectedConsoleFailure(failure, failures, expectedHttpFailure)) {
      expectedConsoleFailures.push(failure);
      continue;
    }
    if (acceptedCaptureFailure(failure, failures, observations)) {
      acceptedCaptureFailures.push(failure);
      captureIncomplete = true;
      continue;
    }
    if (kind === "http" && expectedHttpFailure(failure)) {
      expectedHttpFailures.push(failure);
      continue;
    }
    if (kind === "diagnostic-collection" || kind === "diagnostic-drain") captureIncomplete = true;
    let sourceOrigin;
    if (kind?.startsWith("console:")) {
      if (failure.consoleOriginSource === "document-context" || failure.consoleOriginSource === "resource-url") {
        try {
          sourceOrigin = new URL(failure.consoleOrigin).origin;
        } catch {
          sourceOrigin = undefined;
        }
      } else if (failure.consoleOriginSource !== "unknown" && typeof failure.location?.url === "string") {
        try {
          sourceOrigin = new URL(failure.location.url).origin;
        } catch {
          sourceOrigin = undefined;
        }
      }
    } else {
      const sourceUrl = failure.url ?? failure.context?.url ?? failure.response?.url;
      if (typeof sourceUrl === "string") {
        try {
          sourceOrigin = new URL(sourceUrl).origin;
        } catch {
          sourceOrigin = undefined;
        }
      }
    }
    if (sourceOrigin && !origins.has(sourceOrigin)) {
      thirdPartyDiagnostics.push(failure);
    } else {
      blockingFailures.push(failure);
    }
  }

  for (const name of missingAssertions) {
    blockingFailures.push({ kind: "assertion-missing", name });
  }
  for (const assertion of failedAssertions) {
    blockingFailures.push({ kind: "assertion-failed", assertion });
  }
  if (cleanupStatus !== "verified") {
    blockingFailures.push({ kind: "cleanup", status: cleanupStatus ?? "unknown" });
  }
  if (evidenceWriteFailed) {
    blockingFailures.push({ kind: "evidence-write", error: "The run log could not be written completely." });
  }

  return {
    workflowStatus: blockingFailures.length === 0 ? "passed" : "failed",
    cleanupStatus: cleanupStatus === "verified" ? "verified" : "failed",
    captureStatus: captureIncomplete ? "incomplete" : "complete",
    requiredAssertions,
    passedAssertions: assertions.filter(assertion => assertion.passed === true).length,
    missingAssertions,
    failedAssertions,
    blockingFailures,
    thirdPartyDiagnostics,
    acceptedCaptureFailures,
    expectedHttpFailures,
    expectedConsoleFailures,
    warnings,
  };
}

async function serializeResponseBody(responseBody, responseHeaders, context, options) {
  const contentType = contentTypeOf(responseHeaders);
  const isTextResponse =
    /(?:^|\/|\+)(?:json|javascript|xml|svg|css|html|x-www-form-urlencoded)(?:[;+]|$)/i.test(contentType) ||
    /^text\//i.test(contentType);
  let body;
  let bodyCaptured = false;
  const bytes = responseBytes(responseBody);
  let decodedBodyText;
  if (bytes) {
    try {
      decodedBodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      decodedBodyText = undefined;
    }
  }
  if (typeof responseBody === "string" || decodedBodyText !== undefined) {
    const textBody = typeof responseBody === "string" ? responseBody : decodedBodyText;
    try {
      body = safeBody(JSON.parse(textBody));
      bodyCaptured = true;
    } catch {
      if (typeof responseBody === "string" || isTextResponse || !contentType) {
        body = safeText(textBody);
        bodyCaptured = true;
      }
    }
  }
  if (!bodyCaptured && bytes) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let artifact;
    if (options.binaryArtifactDir) {
      try {
        await mkdir(options.binaryArtifactDir, { recursive: true, mode: 0o700 });
        const name = `${options.binaryPrefix ?? "response"}-${options.nextBinaryArtifact()}.bin`;
        const path = join(options.binaryArtifactDir, name);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        artifact = path;
      } catch (error) {
        options.addFailure({
          kind: "diagnostic-collection",
          operation: "binary response artifact",
          ...context,
          error: safeError(error),
        });
      }
    }
    body = {
      binary: true,
      byteLength: bytes.byteLength,
      sha256,
      ...(artifact ? { artifact } : {}),
      ...(!artifact ? { base64: bytes.toString("base64") } : {}),
    };
    bodyCaptured = true;
  }
  return { body: bodyCaptured ? body : responseBody, bodyCaptured, bytes };
}

function responseHeaderHint(response) {
  try {
    return typeof response.headers === "function" ? response.headers() : {};
  } catch {
    return {};
  }
}

function responseBodyCaptureEvidence({ isBlob, bodylessResponse, bodyCaptured, independentCapture, networkState }) {
  if (isBlob) return { bodyCaptured: false, bodyCaptureStatus: "referenced" };
  if (bodylessResponse) return { bodyCaptured: false, bodyCaptureStatus: "bodyless" };
  if (!bodyCaptured) {
    return {
      bodyCaptured: false,
      bodyCaptureStatus: "incomplete",
      bodyCompletenessReason: "body-read-failed",
    };
  }
  if (independentCapture || networkState === "finished") {
    return { bodyCaptured: true, bodyCaptureStatus: "complete" };
  }
  return {
    bodyCaptured: true,
    bodyCaptureStatus: "unknown",
    bodyCompletenessReason: networkState === "failed" ? "request-failed" : "request-not-finished",
  };
}

function captureResponse(response, options, state) {
  const request = response.request();
  const responseId = state.responseId;
  const url = safeUrl(response.url());
  const resourceType = request.resourceType();
  const fromServiceWorker = typeof response.fromServiceWorker === "function"
    ? response.fromServiceWorker()
    : undefined;
  const isBlob = response.url().startsWith("blob:");
  const isMockResponse = options.mockResponseBodiesOrigin && fromServiceWorker &&
    new URL(response.url()).origin === options.mockResponseBodiesOrigin;
  const context = {
    ...state.context,
    status: response.status(),
    ...(fromServiceWorker !== undefined ? { fromServiceWorker } : {}),
  };
  state.responseStatus = response.status();
  state.fromServiceWorker = fromServiceWorker;
  if (isMockResponse) {
    options.record("mock-response-delegated", {
      ...context,
      responseId,
      method: request.method(),
      url,
    });
    return;
  }

  const routedBodyPromise = options.responseBodies?.get(request);
  const headerHint = responseHeaderHint(response);
  const redirectResponse = context.status >= 300 && context.status <= 399;
  const bodylessResponse = request.method() === "HEAD" || [204, 304].includes(context.status) || redirectResponse;
  const bodylessReason = redirectResponse
    ? "Playwright does not expose response bodies for 3xx responses"
    : "HTTP response has no body";
  let responseHeadersValue;
  let responseBodySerialized;

  const responseHeadersTask = (routedBodyPromise
    ? routedBodyPromise.then(capture => capture.ok ? capture.headers : { collection_error: safeError(capture.error) })
    : collect("response headers", () => readHeaders(response), context, options.addFailure)
  ).then(headers => {
    responseHeadersValue = headers;
    return headers;
  });

  let responseBodyTask;
  if (isBlob) {
    responseBodyTask = Promise.resolve({
      captureSource: "blob-source",
      blobId: createHash("sha256").update(response.url()).digest("hex"),
    });
  } else if (bodylessResponse) {
    responseBodyTask = Promise.resolve({ unavailable: true, reason: bodylessReason });
  } else if (routedBodyPromise) {
    responseBodyTask = routedBodyPromise.then(capture => {
      if (!capture.ok) return { captureError: capture.error, captureSource: "playwright-route-fetch" };
      if (capture.status !== context.status) {
        const error = new Error("Routed subscription response status did not match the browser response.");
        options.addFailure({
          kind: "diagnostic-collection",
          operation: "verify routed subscription response",
          ...context,
          error: safeError(error),
        });
        return { captureError: error, captureSource: "playwright-route-fetch" };
      }
      return { bytes: capture.bytes, captureSource: "playwright-route-fetch", headers: capture.headers };
    });
  } else {
    responseBodyTask = collect(
      "response body",
      () => (typeof response.body === "function" ? response.body() : response.text()),
      context,
      options.addFailure
    );
  }
  responseBodyTask = responseBodyTask.then(async bodyResult => {
    if (bodyResult?.captureError) {
      responseBodySerialized = { body: { collection_error: safeError(bodyResult.captureError) }, bodyCaptured: false };
    } else if (isBlob) {
      responseBodySerialized = { body: bodyResult, bodyCaptured: true };
    } else if (bodylessResponse) {
      responseBodySerialized = { body: bodyResult, bodyCaptured: false };
    } else if (isObject(bodyResult) && Object.hasOwn(bodyResult, "collection_error")) {
      responseBodySerialized = { body: bodyResult, bodyCaptured: false };
    } else {
      const bodyBytes = bodyResult?.bytes ?? bodyResult;
      const headersForSerialization = bodyResult?.headers ?? headerHint;
      responseBodySerialized = await serializeResponseBody(bodyBytes, headersForSerialization, context, options);
    }
    return responseBodySerialized;
  });
  const captureTask = Promise.all([
    responseHeadersTask,
    responseBodyTask,
    state.requestHeadersTask,
    state.requestBodyTask,
    state.requestStarted ? state.networkSettled : Promise.resolve(),
  ]).then(() => {
    const captureSource = routedBodyPromise && !isBlob ? "playwright-route-fetch" : "playwright";
    const bodyEvidence = responseBodyCaptureEvidence({
      isBlob,
      bodylessResponse,
      bodyCaptured: Boolean(responseBodySerialized?.bodyCaptured),
      independentCapture: captureSource === "playwright-route-fetch",
      networkState: state.networkState,
    });
    options.record("http", {
      responseId,
      ...(state.frameId ? { frameId: state.frameId } : {}),
      status: context.status,
      method: request.method(),
      resourceType,
      url,
      requestHeaders: safeHeaders(state.requestHeadersValue),
      headers: safeHeaders(responseHeadersValue),
      requestBody: state.requestBodyValue,
      body: responseBodySerialized?.body,
      ...bodyEvidence,
      captureSource,
      ...(fromServiceWorker !== undefined ? { fromServiceWorker } : {}),
    });
    if (context.status >= 400) {
      options.addFailure({
        kind: "http",
        responseId,
        url,
        method: request.method(),
        resourceType,
        status: context.status,
      });
    }
  });
  trackPending(options.pending, "response capture", captureTask, context, options.addFailure);
}

async function captureConsole(message, options) {
  const location = safeBody(message.location());
  const item = {
    type: message.type(),
    text: safeText(message.text()),
    location,
    argumentSource: "console-call",
  };
  if (item.type === "error") {
    let args;
    try {
      args = message.args();
    } catch (error) {
      item.consoleOriginSource = "unknown";
      item.consoleAttributionError = safeError(error);
      options.addFailure({
        kind: "diagnostic-collection",
        operation: "console document origin",
        ...item,
        error: safeError(error),
      });
    }
    if (Array.isArray(args) && args.length > 0 && typeof args[0]?.evaluate === "function") {
      try {
        const origin = await args[0].evaluate(() => {
          try {
            const origin = new URL(globalThis.location.href).origin;
            return origin === "null" ? undefined : origin;
          } catch {
            return undefined;
          }
        });
        if (typeof origin === "string" && /^https?:\/\//i.test(origin)) {
          item.consoleOrigin = new URL(origin).origin;
          item.consoleOriginSource = "document-context";
        } else {
          item.consoleOriginSource = "unknown";
        }
      } catch (error) {
        item.consoleOriginSource = "unknown";
        item.consoleAttributionError = safeError(error);
        options.addFailure({
          kind: "diagnostic-collection",
          operation: "console document origin",
          ...item,
          error: safeError(error),
        });
      }
    } else if (args === undefined && item.consoleOriginSource === "unknown") {
      // Reading the arguments itself failed; a URL fallback would hide that loss of attribution.
    } else {
      try {
        const resourceUrl = location?.url;
        const origin = typeof resourceUrl === "string" ? new URL(resourceUrl).origin : undefined;
        if (origin && ["http:", "https:"].includes(new URL(resourceUrl).protocol)) {
          item.consoleOrigin = origin;
          item.consoleOriginSource = "resource-url";
        } else {
          item.consoleOriginSource = "unknown";
        }
      } catch {
        item.consoleOriginSource = "unknown";
      }
    }
  } else {
    item.consoleOriginSource = "not-required";
  }
  options.record("console", item);
  if (message.type() === "error" || message.type() === "warning") {
    options.addFailure({ kind: `console:${message.type()}`, ...item });
  }
  if (message.text().startsWith("MSW mocked response capture hook unavailable: ")) {
    options.addFailure({
      kind: "diagnostic-collection",
      operation: "MSW mocked response body hook",
      ...item,
      error: safeError(new Error(message.text())),
    });
  }
  if (message.text() === "Blob source capture failed") {
    options.addFailure({ kind: "diagnostic-collection", operation: "blob source binding", ...item });
  }
}

function captureRequestFailure(request, options, state) {
  const error = safeText(request.failure()?.errorText ?? "unknown");
  const item = {
    ...state.context,
    requestHeaders: state.requestHeadersReady
      ? safeHeaders(state.requestHeadersValue)
      : { captureStatus: "not-recorded" },
    requestBody: state.requestBodyReady
      ? state.requestBodyValue
      : { captureStatus: "not-recorded" },
    error,
  };
  options.record("requestfailed", item);
  options.addFailure({ kind: "requestfailed", ...item });
}

export function installPageDiagnostics(
  page,
  { record, addFailure, pending = [], binaryArtifactDir, mockResponseBodiesOrigin, responseBodies } = {}
) {
  let diagnosticOrder = 0;
  const recordEvent = (kind, item) => record(kind, { ...item, diagnosticOrder: ++diagnosticOrder });
  const addDiagnosticFailure = item => addFailure({ ...item, diagnosticOrder: ++diagnosticOrder });
  let binarySequence = 0;
  let timelineSequence = 0;
  const requestIds = new WeakMap();
  const frameIds = new WeakMap();
  const requestFrameIds = new WeakMap();
  const requestStates = new WeakMap();
  let requestSequence = 0;
  let frameSequence = 0;
  const eventStamp = () => ({
    timelineSequence: ++timelineSequence,
    eventAt: new Date().toISOString(),
    eventMonotonicMs: monotonicNow(),
  });
  const recordObserved = (kind, item) => recordEvent(kind, { ...eventStamp(), ...item });
  const options = {
    record: recordEvent,
    recordObserved,
    addFailure: addDiagnosticFailure,
    pending,
    binaryArtifactDir,
    mockResponseBodiesOrigin,
    responseBodies,
    nextBinaryArtifact: () => ++binarySequence,
    responseIdFor(request) {
      let requestId = requestIds.get(request);
      if (!requestId) {
        requestId = "playwright-request-" + (++requestSequence);
        requestIds.set(request, requestId);
      }
      return { source: "playwright", requestId };
    },
    frameIdFor(frame) {
      if (!frame || (typeof frame !== "object" && typeof frame !== "function")) return undefined;
      let frameId = frameIds.get(frame);
      if (!frameId) {
        frameId = "playwright-frame-" + (++frameSequence);
        frameIds.set(frame, frameId);
      }
      return frameId;
    },
    frameIdForRequest(request) {
      let frameId = requestFrameIds.get(request);
      if (frameId) return frameId;
      try {
        frameId = options.frameIdFor(request.frame());
      } catch {
        return undefined;
      }
      if (frameId) requestFrameIds.set(request, frameId);
      return frameId;
    },
    requestStateFor(request) {
      let state = requestStates.get(request);
      if (state) return state;
      const responseId = options.responseIdFor(request);
      const frameId = options.frameIdForRequest(request);
      const context = {
        responseId,
        ...(frameId ? { frameId } : {}),
        url: safeUrl(request.url()),
        method: request.method(),
        resourceType: request.resourceType(),
      };
      let networkSettledResolve;
      const networkSettled = new Promise(resolve => { networkSettledResolve = resolve; });
      state = {
        responseId,
        frameId,
        context,
        networkState: "not-observed",
        requestStarted: false,
        requestEvidenceStarted: false,
        requestHeadersReady: false,
        requestBodyReady: false,
        networkSettled,
        networkSettledResolve,
      };
      requestStates.set(request, state);
      return state;
    },
    ensureRequestEvidence(request, state = options.requestStateFor(request)) {
      if (state.requestEvidenceStarted) return state;
      state.requestEvidenceStarted = true;
      const headersTask = collect(
        "request headers",
        () => readHeaders(request),
        state.context,
        options.addFailure,
      ).then(headers => {
        state.requestHeadersValue = headers;
        state.requestHeadersReady = true;
        return headers;
      });
      state.requestHeadersTask = headersTask;

      const bodyTask = headersTask.then(headers => collect(
        "request body",
        () => requestBody(request, headers),
        state.context,
        options.addFailure,
      )).then(body => {
        state.requestBodyValue = body;
        state.requestBodyReady = true;
        return body;
      });
      state.requestBodyTask = bodyTask;
      return state;
    },
  };
  const listeners = new Map();
  const listen = (event, listener) => {
    page.on(event, listener);
    listeners.set(event, listener);
  };
  listen("console", (message) => {
    track(pending, "console capture", captureConsole(message, options), {}, options.addFailure);
  });
  listen("pageerror", (error) => {
    options.addFailure({ kind: "pageerror", error: safeError(error) });
  });
  listen("crash", () => {
    const event = eventStamp();
    options.record("page-crash", {
      ...event,
      error: { name: "PageCrash", message: "The page crashed.", stack: "" },
    });
    options.addFailure({
      kind: "page-crash",
      error: { name: "PageCrash", message: "The page crashed.", stack: "" },
      ...event,
    });
  });
  listen("close", () => {
    options.record("page-close-event", eventStamp());
  });
  listen("frameattached", (frame) => {
    options.recordObserved("frame-attached", {
      frameId: options.frameIdFor(frame),
      url: safeUrl(frame.url()),
    });
  });
  listen("framenavigated", (frame) => {
    let isMainFrame;
    try { isMainFrame = page.mainFrame() === frame; } catch { isMainFrame = undefined; }
    options.recordObserved("frame-navigated", {
      frameId: options.frameIdFor(frame),
      url: safeUrl(frame.url()),
      ...(isMainFrame !== undefined ? { isMainFrame } : {}),
    });
  });
  listen("framedetached", (frame) => {
    options.recordObserved("frame-detached", { frameId: options.frameIdFor(frame) });
  });
  listen("request", (request) => {
    try {
      const state = options.requestStateFor(request);
      state.requestStarted = true;
      const event = eventStamp();
      if (!["finished", "failed"].includes(state.networkState)) state.networkState = "in-progress";
      let redirectedFrom;
      try {
        const previous = request.redirectedFrom?.();
        if (previous) redirectedFrom = options.responseIdFor(previous);
      } catch { /* Redirect linkage is optional for requests without one. */ }
      options.record("request-started", {
        ...state.context,
        ...event,
        ...(redirectedFrom ? { redirectedFrom } : {}),
      });
      options.ensureRequestEvidence(request, state);
    } catch (error) {
      options.addFailure({
        kind: "diagnostic-collection",
        operation: "request metadata",
        error: safeError(error),
      });
    }
  });
  listen("requestfinished", (request) => {
    try {
      const state = options.requestStateFor(request);
      if (state.networkState !== "failed") state.networkState = "finished";
      state.networkSettledResolve?.(state.networkState);
      options.recordObserved("request-finished", state.context);
    } catch (error) {
      options.addFailure({
        kind: "diagnostic-collection",
        operation: "request completion metadata",
        error: safeError(error),
      });
    }
  });
  listen("requestfailed", (request) => {
    try {
      const state = options.requestStateFor(request);
      options.ensureRequestEvidence(request, state);
      state.networkState = "failed";
      state.networkSettledResolve?.("failed");
      options.recordObserved("request-failed", {
        ...state.context,
        error: safeText(request.failure()?.errorText ?? "unknown"),
      });
      captureRequestFailure(request, options, state);
    } catch (error) {
      options.addFailure({
        kind: "diagnostic-collection",
        operation: "failed request metadata",
        error: safeError(error),
      });
    }
  });
  listen("response", (response) => {
    try {
      const request = response.request();
      const state = options.requestStateFor(request);
      options.ensureRequestEvidence(request, state);
      if (!["finished", "failed"].includes(state.networkState)) state.networkState = "response-received";
      const fromServiceWorker = typeof response.fromServiceWorker === "function"
        ? response.fromServiceWorker()
        : undefined;
      options.recordObserved("response-received", {
        ...state.context,
        status: response.status(),
        ...(fromServiceWorker !== undefined ? { fromServiceWorker } : {}),
      });
      captureResponse(response, options, state);
    } catch (error) {
      options.addFailure({
        kind: "diagnostic-collection",
        operation: "response metadata",
        error: safeError(error),
      });
    }
  });
  const removeListeners = () => {
    for (const [event, listener] of listeners) {
      page.off(event, listener);
    }
  };
  removeListeners.recordLifecycle = (kind, item) => recordObserved(kind, item);
  return removeListeners;
}
