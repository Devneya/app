/* global Buffer, Headers, Response, TextDecoder, URL, URLSearchParams */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installConsoleCapture } from "./console-capture.mjs";
import { installBlobCapture } from "./blob-capture.mjs";

const SENSITIVE_KEY =
  /(?:^|[_-])(?:password|secret|authorization|cookie|api[_-]?key|key|token(?=$|[_-](?:hash|prefix)(?:$|_))|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|client[_-]?secret|checkout[_-]?(?:url|link)|portal[_-]?(?:url|link)|payment[_-]?link|signature|sig|x-(?:amz|goog)-[\w-]+|card[_-]?number|cvv|cvc|email)(?:$|[_-])/i;

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

function safeUrlPath(pathname) {
  return pathname
    .replace(
      /(\/(?:buy|checkout|portal|payment(?:-link)?)(?:\/(?:session|link|shortlink))?\/)([^/]+)/gi,
      (match, prefix, segment) =>
        /^(?:sub|cus|pmt|pay|evt|req)_[A-Za-z0-9_-]+$/.test(segment)
          ? match
          : `${prefix}[redacted-capability]`,
    )
    .replace(/(?:cks|cs)_[A-Za-z0-9_-]+/g, "[redacted-capability]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-token]")
    .replace(/sk-bf-[A-Za-z0-9_-]+/g, "[redacted-key]");
}

function safeUrlQuery(url) {
  const sensitive =
    /^(?:password|secret|authorization|cookie|api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|client[_-]?secret|code|state|nonce|signature|sig|x-(?:amz|goog)-[^=]+|checkout[_-]?(?:url|link)|portal[_-]?(?:url|link)|payment[_-]?link|card|cvv|cvc|email)$/i;
  return [...url.searchParams]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(sensitive.test(key) ? "[redacted]" : safeText(value))}`)
    .join("&");
}

function isLikelyCard(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "blob:") return `blob:${safeUrl(url.pathname + url.search)}`;
    if (url.protocol !== "https:" && url.protocol !== "http:") return safeText(value, false);
    const query = safeUrlQuery(url);
    const hash = url.hash ? `#${safeText(url.hash.slice(1), false)}` : "";
    if (/(^|\.)checkout\.dodopayments\.com$/.test(url.hostname) && /^\/[^/.]+\/?$/.test(url.pathname)) {
      return `${url.origin}/[redacted-capability]${query ? `?${query}` : ""}${hash}`;
    }
    return `${url.origin}${safeUrlPath(url.pathname)}${query ? `?${query}` : ""}${hash}`;
  } catch {
    return safeText(value, false);
  }
}

export function safeText(value, scrubUrls = true) {
  return String(value)
    .replace(/\{[^{}]*\}/g, (fragment) => {
      try {
        const descriptor = JSON.parse(fragment);
        if (typeof descriptor.name === "string" && SENSITIVE_KEY.test(descriptor.name) && "value" in descriptor) {
          return JSON.stringify({ ...descriptor, value: "[redacted]" });
        }
      } catch { /* Not a JSON descriptor; the text rules below still apply. */ }
      return fragment;
    })
    .replace(/\b(?:cks|cs)_[A-Za-z0-9_-]+/g, "[redacted-capability]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[redacted]@")
    .replace(/https?:\/\/[^\s\\"<>]+/g, (url) => scrubUrls ? safeUrl(url) : url)
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[^\s"']+/gi, "Basic [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-token]")
    .replace(/sk-bf-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/(["'][\w-]*token["']\s*:\s*)["'][^"']*["']/gi, '$1"[redacted]"')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, (digits) =>
      isLikelyCard(digits) ? "[redacted-card]" : digits
    )
    .replace(
      /((?:^|[?&])(?:password|secret|authorization|cookie|api[_-]?key|token|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|code|state|nonce|checkout[_-]?(?:url|link)|portal[_-]?(?:url|link)|payment[_-]?link|signature|sig|x-(?:amz|goog)-[^=]*|card|cvv|cvc)=)[^&#\s]+/gi,
      "$1[redacted]"
    )
    .replace(
      /(["'](?:password|[\w-]*secret|authorization|cookie|access_token|refresh_token|id_token|token|key|email|checkout_url|portal_url)["']\s*:\s*)["'][^"']*["']/gi,
      '$1"[redacted]"'
    )
    .replace(
      /(["'](?:password|secret|authorization|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|key|email|card|cvv|cvc|[\w-]+[_-](?:password|secret|token|key))["']\s*:\s*)["'][^"']*["']/gi,
      '$1"[redacted]"'
    )
    .replace(
      /(\b(?:password|secret|authorization|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|key|email|card|cvv|cvc|[\w-]+[_-](?:password|secret|token|key))\b\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
      "$1[redacted]"
    );
}

export function safeError(error, seen = new WeakSet()) {
  if (error instanceof Error) {
    if (seen.has(error)) return { message: "[circular-error]" };
    seen.add(error);
    try {
    const output = {
      name: safeText(error.name || "Error"),
      message: safeText(error.message || String(error)),
      stack: safeText(error.stack || ""),
    };
    if (typeof AggregateError !== "undefined" && error instanceof AggregateError && Array.isArray(error.errors)) {
      output.errors = error.errors.map((item) => (isObject(item) ? safeError(item, seen) : { message: safeText(item) }));
    }
    if ("cause" in error && error.cause !== undefined) {
      output.cause = isObject(error.cause)
        ? safeError(error.cause, seen)
        : { message: safeText(error.cause) };
    }
    for (const [key, value] of Object.entries(error)) {
      if (key === "cause" || key in output) continue;
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : safeBody(value, seen);
    }
    return output;
    } finally {
      seen.delete(error);
    }
  }
  if (isObject(error)) {
    return { name: "Error", message: safeText(error.message ?? String(error)), details: safeBody(error, seen) };
  }
  return { name: "Error", message: safeText(error), stack: "" };
}

export function safeBody(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return safeText(value);
  if (typeof value !== "object") return value;
  if (value instanceof Error) return safeError(value, seen);
  if (value instanceof URL) return safeUrl(value.href);
  if (value instanceof Headers) return safeHeaders(value, seen);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
  if (Array.isArray(value)) return value.map((item) => safeBody(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const credentialValue = key.toLowerCase() === "value" &&
      typeof value.name === "string" && SENSITIVE_KEY.test(value.name);
    output[key] = SENSITIVE_KEY.test(key) || /token$/i.test(key) || credentialValue
      ? "[redacted]"
      : safeBody(item, seen);
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
        fields.push({ name, filename: safeText(value.name), contentType: value.type,
          contents: SENSITIVE_KEY.test(name) ? "[redacted]" : contents });
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

function track(pending, operation, task, context, addFailure) {
  const tracked = Promise.resolve(task);
  tracked.catch((error) => {
    addFailure({
      kind: "diagnostic-collection",
      operation,
      ...context,
      error: safeError(error),
    });
  });
  pending.push(tracked);
  return tracked;
}

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
  { record, addFailure, pending = [], binaryArtifactDir } = {},
) {
  await installConsoleCapture(page, payload => {
    const safe = safeBody(payload);
    record("console-call", safe);
    if (payload.kind !== "console-call") {
      addFailure({ kind: "diagnostic-collection", operation: "console source snapshot", ...safe });
    }
  });
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
  return {
    responseBodyCapture: "Playwright response bodies; MSW owns mocked bodies; blob bytes captured at creation",
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
          reason: new Error("Browser capture exceeded the five-second teardown window; close the page and retain remaining reader errors."),
        }]), 5000);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function closeCapturedPage({ pending = [], removeDiagnostics, page } = {}) {
  const settledTasks = new Map();
  const drainTimeouts = [];
  const closeErrors = [];
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
    } catch (error) {
      closeErrors.push({ operation, error });
    }
  };

  await drain("drain before capture shutdown");
  await attempt("remove page diagnostics listeners", removeDiagnostics);
  await attempt("close page", () => page?.close());
  await drain("drain after page close");
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
    bodyCaptureComplete: true,
    fromServiceWorker: true,
    captureSource: "msw-response:mocked",
  });
}

export function missingResponseBodies(observations) {
  const blobIds = new Set(observations.filter(item => item.kind === "blob-source").map(item => item.blobId));
  const missingBlobs = observations
    .filter(item => item.kind === "http" && item.body?.captureSource === "blob-source" && !blobIds.has(item.body.blobId))
    .map(item => ({
      responseId: item.responseId,
      ...(item.frameId ? { frameId: item.frameId } : {}),
      method: item.method,
      url: item.url,
      status: item.status,
      captureSource: "blob-source",
    }));
  const incompleteResponses = observations
    .filter(item => item.kind === "http" && item.captureSource === "playwright")
    .filter(item => item.bodyCaptureComplete !== true && !["bodyless", "referenced"].includes(item.bodyCaptureStatus))
    .map(item => ({
      responseId: item.responseId,
      ...(item.frameId ? { frameId: item.frameId } : {}),
      method: item.method,
      url: item.url,
      status: item.status,
      captureSource: "playwright",
      body: item.body,
    }));
  const mockResponseKey = item => JSON.stringify([item.method, item.url, item.status]);
  const delegatedMockResponses = observations.filter(item => item.kind === "mock-response-delegated");
  const capturedMockResponses = observations.filter(item =>
    item.kind === "http" && item.captureSource === "msw-response:mocked" && item.bodyCaptureComplete === true);
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
  const missingMockResponses = [];
  for (const [key, delegated] of delegatedByKey) {
    const missingCount = delegated.length - (capturedCounts.get(key) ?? 0);
    for (const item of delegated.slice(0, Math.max(0, missingCount))) {
      missingMockResponses.push({
        responseId: item.responseId,
        method: item.method,
        url: item.url,
        status: item.status,
        captureSource: "msw-response:mocked",
      });
    }
  }
  const delegatedCounts = new Map([...delegatedByKey].map(([key, items]) => [key, items.length]));
  const extraMockResponses = [];
  for (const [key, capturedCount] of capturedCounts) {
    const extraCount = capturedCount - (delegatedCounts.get(key) ?? 0);
    if (extraCount <= 0) continue;
    const matching = capturedMockResponses.filter(item => mockResponseKey(item) === key);
    for (const item of matching.slice(-extraCount)) {
      extraMockResponses.push({
        responseId: item.responseId,
        method: item.method,
        url: item.url,
        status: item.status,
        captureSource: "msw-response:mocked-unmatched",
      });
    }
  }
  const seenMockRequestIds = new Set();
  const duplicateMockResponses = [];
  for (const item of capturedMockResponses) {
    const requestId = item.responseId?.requestId;
    if (typeof requestId !== "string") continue;
    if (seenMockRequestIds.has(requestId)) {
      duplicateMockResponses.push({
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
  return [...missingBlobs, ...incompleteResponses, ...missingMockResponses, ...extraMockResponses, ...duplicateMockResponses];
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
    const sourceUrl = kind?.startsWith("console:")
      ? failure.location?.url
      : failure.url ?? failure.context?.url ?? failure.response?.url;
    let sourceOrigin;
    if (typeof sourceUrl === "string") {
      try {
        sourceOrigin = new URL(sourceUrl).origin;
      } catch {
        sourceOrigin = undefined;
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
      const likelySensitiveText =
        /(?:password|secret|authorization|cookie|api[_-]?key|token|bearer|basic|card|cvv|cvc|email)\s*[:=]/i.test(textBody);
      if (typeof responseBody === "string" || isTextResponse || !contentType || likelySensitiveText) {
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

async function captureResponse(response, options) {
  const request = response.request();
  const responseId = options.responseIdFor(request);
  const frameId = options.frameIdForRequest(request);
  const url = safeUrl(response.url());
  const resourceType = request.resourceType();
  const fromServiceWorker = typeof response.fromServiceWorker === "function"
    ? response.fromServiceWorker()
    : undefined;
  const isBlob = response.url().startsWith("blob:");
  const isMockResponse = options.mockResponseBodiesOrigin && fromServiceWorker &&
    new URL(response.url()).origin === options.mockResponseBodiesOrigin;
  if (isMockResponse) {
    options.record("mock-response-delegated", {
      responseId,
      method: request.method(),
      url,
      status: response.status(),
    });
    return;
  }
  const context = {
    responseId,
    ...(frameId ? { frameId } : {}),
    url,
    method: request.method(),
    status: response.status(),
    ...(fromServiceWorker !== undefined ? { fromServiceWorker } : {}),
  };
  const responseHeadersTask = collect(
    "response headers",
    () => readHeaders(response),
    context,
    options.addFailure
  );
  const redirectResponse = context.status >= 300 && context.status <= 399;
  const bodylessResponse = request.method() === "HEAD" || [204, 304].includes(context.status) || redirectResponse;
  const bodylessReason = redirectResponse
    ? "Playwright does not expose response bodies for 3xx responses"
    : "HTTP response has no body";
  const responseBodyTask = isBlob
    ? Promise.resolve({ captureSource: "blob-source", blobId: createHash("sha256").update(response.url()).digest("hex") })
    : bodylessResponse
    ? Promise.resolve({ unavailable: true, reason: bodylessReason })
    : collect(
        "response body",
        () => (typeof response.body === "function" ? response.body() : response.text()),
        context,
        options.addFailure
      );
  const [responseHeaders, responseBody] = await Promise.all([responseHeadersTask, responseBodyTask]);
  const serialized = await serializeResponseBody(responseBody, responseHeaders, context, options);
  const requestHeaders = await collect(
    "request headers",
    () => readHeaders(request),
    context,
    options.addFailure
  );
  const requestData = await collect(
    "request body",
    () => requestBody(request, requestHeaders),
    context,
    options.addFailure
  );
  const bodyCaptureStatus = isBlob
    ? "referenced"
    : bodylessResponse
    ? "bodyless"
    : serialized.bodyCaptured
    ? "complete"
    : "incomplete";
  const item = {
    responseId,
    ...(frameId ? { frameId } : {}),
    status: response.status(),
    method: request.method(),
    resourceType,
    url,
    requestHeaders: safeHeaders(requestHeaders),
    headers: safeHeaders(responseHeaders),
    requestBody: requestData,
    body: serialized.body,
    bodyCaptureComplete: bodylessResponse || serialized.bodyCaptured,
    bodyCaptureStatus,
    captureSource: "playwright",
    ...(context.fromServiceWorker !== undefined ? { fromServiceWorker: context.fromServiceWorker } : {}),
  };
  options.record("http", item);
  if (response.status() >= 400) {
    options.addFailure({
      kind: "http",
      responseId,
      url,
      method: request.method(),
      resourceType,
      status: response.status(),
    });
  }
}

async function captureConsole(message, options) {
  const item = {
    type: message.type(),
    text: safeText(message.text()),
    location: safeBody(message.location()),
    argumentSource: "console-call",
  };
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

async function captureRequestFailure(request, options) {
  const responseId = options.responseIdFor(request);
  const frameId = options.frameIdForRequest(request);
  const context = {
    responseId,
    ...(frameId ? { frameId } : {}),
    url: safeUrl(request.url()),
    method: request.method(),
    resourceType: request.resourceType(),
  };
  const headers = await collect(
    "failed request headers",
    () => readHeaders(request),
    context,
    options.addFailure
  );
  const requestData = await collect(
    "failed request body",
    () => requestBody(request, headers),
    context,
    options.addFailure
  );
  const item = {
    ...context,
    requestHeaders: safeHeaders(headers),
    requestBody: requestData,
    error: safeText(request.failure()?.errorText ?? "unknown"),
  };
  options.record("requestfailed", item);
  options.addFailure({ kind: "requestfailed", ...item });
}

export function installPageDiagnostics(
  page,
  { record, addFailure, pending = [], binaryArtifactDir, mockResponseBodiesOrigin } = {}
) {
  let diagnosticOrder = 0;
  const recordEvent = (kind, item) => record(kind, { ...item, diagnosticOrder: ++diagnosticOrder });
  const addDiagnosticFailure = item => addFailure({ ...item, diagnosticOrder: ++diagnosticOrder });
  let binarySequence = 0;
  const requestIds = new WeakMap();
  const frameIds = new WeakMap();
  const requestFrameIds = new WeakMap();
  let requestSequence = 0;
  let frameSequence = 0;
  const options = {
    record: recordEvent,
    addFailure: addDiagnosticFailure,
    binaryArtifactDir,
    mockResponseBodiesOrigin,
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
    options.addFailure({
      kind: "page-crash",
      error: { name: "PageCrash", message: "The page crashed.", stack: "" },
    });
  });
  listen("framedetached", (frame) => {
    options.record("frame-detached", { frameId: options.frameIdFor(frame) });
  });
  listen("requestfailed", (request) => {
    try {
      track(
        pending,
        "failed request capture",
        captureRequestFailure(request, options),
        { url: safeUrl(request.url()), method: request.method() },
        options.addFailure
      );
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
      track(
        pending,
        "response capture",
        captureResponse(response, options),
        { url: safeUrl(response.url()), method: response.request().method() },
        options.addFailure
      );
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
  return removeListeners;
}
