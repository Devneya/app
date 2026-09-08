/* global Buffer, Headers, TextDecoder, URL, URLSearchParams */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SENSITIVE_KEY =
  /(?:^|[_-])(?:password|secret|authorization|cookie|api[_-]?key|key|value|token(?=$|[_-](?:hash|prefix)(?:$|_))|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|client[_-]?secret|checkout[_-]?(?:url|link)|portal[_-]?(?:url|link)|payment[_-]?link|signature|sig|x-(?:amz|goog)-[\w-]+|card|cvv|cvc|email)(?:$|[_-])/i;

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
    const query = safeUrlQuery(url);
    if (/(^|\.)checkout\.dodopayments\.com$/.test(url.hostname) && /^\/[^/.]+\/?$/.test(url.pathname)) {
      return `${url.origin}/[redacted-capability]${query ? `?${query}` : ""}`;
    }
    return `${url.origin}${safeUrlPath(url.pathname)}${query ? `?${query}` : ""}`;
  } catch {
    return "[invalid-url]";
  }
}

export function safeText(value) {
  return String(value)
    .replace(/\b(?:cks|cs)_[A-Za-z0-9_-]+/g, "[redacted-capability]")
    .replace(/https?:\/\/[^\s\\"<>]+/g, (url) => safeUrl(url))
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
      /(["'](?:password|[\w-]*secret|authorization|cookie|access_token|refresh_token|id_token|token|key|value|email|checkout_url|portal_url)["']\s*:\s*)["'][^"']*["']/gi,
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
  if (Array.isArray(value)) return value.map((item) => safeBody(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const numericValue = key.toLowerCase() === "value" && typeof item === "number";
    output[key] = (SENSITIVE_KEY.test(key) || /token$/i.test(key)) && !numericValue
      ? "[redacted]"
      : safeBody(item, seen);
  }
  return output;
}

export function safeHeaders(value, seen = new WeakSet()) {
  if (value && typeof value.entries === "function") {
    return safeBody(Object.fromEntries(value.entries()), seen);
  }
  return safeBody(value, seen);
}

function requestBody(request, requestHeaders) {
  const postData = request.postData();
  if (postData === null) return undefined;
  if (requestHeaders?.collection_error) {
    return { body_unavailable: "request headers could not be collected" };
  }
  const contentType = Object.entries(requestHeaders ?? {}).find(
    ([key]) => key.toLowerCase() === "content-type"
  )?.[1] ?? "";
  if (
    contentType.toLowerCase().includes("multipart/form-data") ||
    /content-disposition:\s*form-data/i.test(postData)
  ) {
    const fieldNames = [...postData.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    return {
      multipart: true,
      fieldNames: fieldNames.map((name) => safeText(name)),
      sensitiveBodyExcluded: true,
      exclusionReason: "multipart values may contain credentials or payment data",
    };
  }
  if (contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return safeBody(Object.fromEntries(new URLSearchParams(postData).entries()));
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
  const tracked = Promise.resolve(task).catch((error) => {
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
    settled.push(...(await Promise.allSettled(batch)));
    drained += batch.length;
  }
  return settled;
}

async function captureResponse(response, options) {
  const request = response.request();
  const url = safeUrl(response.url());
  const context = {
    url,
    method: request.method(),
    status: response.status(),
    ...(typeof response.fromServiceWorker === "function"
      ? { fromServiceWorker: response.fromServiceWorker() }
      : {}),
  };
  const responseHeadersTask = collect(
    "response headers",
    () => response.allHeaders(),
    context,
    options.addFailure
  );
  const responseBodyTask = collect(
    "response body",
    () => (typeof response.body === "function" ? response.body() : response.text()),
    context,
    options.addFailure
  );
  const [responseHeaders, responseBody] = await Promise.all([responseHeadersTask, responseBodyTask]);
  const contentType = Object.entries(responseHeaders ?? {}).find(
    ([key]) => key.toLowerCase() === "content-type"
  )?.[1] ?? "";
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
        const name = `response-${options.nextBinaryArtifact()}.bin`;
        const path = join(options.binaryArtifactDir, name);
        await writeFile(path, bytes, { mode: 0o600 });
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
    };
    bodyCaptured = true;
  }
  if (!bodyCaptured) {
    body = responseBody;
  }
  const requestHeaders = await collect(
    "request headers",
    () => request.allHeaders(),
    context,
    options.addFailure
  );
  const requestData = await collect(
    "request body",
    () => requestBody(request, requestHeaders),
    context,
    options.addFailure
  );
  const item = {
    status: response.status(),
    method: request.method(),
    resourceType: request.resourceType(),
    url,
    requestHeaders: safeHeaders(requestHeaders),
    headers: safeHeaders(responseHeaders),
    requestBody: requestData,
    body,
    ...(context.fromServiceWorker !== undefined
      ? { fromServiceWorker: context.fromServiceWorker }
      : {}),
  };
  options.record("http", item);
  if (response.status() >= 400) options.addFailure({ kind: "http", ...item });
}

async function serializeBrowserError(handle) {
  if (typeof handle.evaluate !== "function") return undefined;
  return handle.evaluate((value) => {
    if (!(value instanceof Error || Object.prototype.toString.call(value) === "[object Error]")) {
      return undefined;
    }
    const seen = new Set();
    const serializeValue = (item) => {
      if (item === null || typeof item !== "object") return item;
      if (item instanceof Error || Object.prototype.toString.call(item) === "[object Error]") return serialize(item);
      if (seen.has(item)) return "[circular]";
      seen.add(item);
      if (Array.isArray(item)) return item.map(serializeValue);
      const output = {};
      for (const [key, entry] of Object.entries(item)) {
        output[key] = serializeValue(entry);
      }
      return output;
    };
    const serialize = (error) => {
      if (!error || typeof error !== "object") return { message: String(error) };
      if (seen.has(error)) return { message: "[circular-error]" };
      seen.add(error);
      const output = {
        name: String(error.name || "Error"),
        message: String(error.message || error),
        stack: String(error.stack || ""),
      };
      if ("cause" in error && error.cause !== undefined) output.cause = serialize(error.cause);
      if (Array.isArray(error.errors)) output.errors = error.errors.map(serialize);
      for (const [key, item] of Object.entries(error)) {
        if (key === "cause" || key === "errors" || key in output) continue;
        output[key] = serializeValue(item);
      }
      return output;
    };
    return { __devneyaError: serialize(value) };
  });
}

async function captureConsoleArg(handle) {
  const browserError = await serializeBrowserError(handle);
  if (browserError?.__devneyaError) return safeBody(browserError.__devneyaError);
  return safeBody(await handle.jsonValue());
}

async function captureConsole(message, options) {
  const args = [];
  const argErrors = [];
  const results = await Promise.all(message.args().map(async (handle, index) => {
    try {
      return { value: await captureConsoleArg(handle) };
    } catch (error) {
      return { error, handle, index };
    }
  }));
  for (const result of results) {
    if ("value" in result) {
      args.push(result.value);
      continue;
    }
    const detail = {
      index: result.index,
      handle: safeText(result.handle),
      error: safeError(result.error),
      ...( /Execution context was destroyed/i.test(result.error?.message ?? "")
        ? { expectedLifecycle: true }
        : {}),
    };
    argErrors.push(detail);
      options.addFailure({
        kind: "diagnostic-collection",
        operation: "console argument",
        error: detail.error,
        ...(detail.expectedLifecycle ? { expectedLifecycle: true } : {}),
      });
  }
  const item = {
    type: message.type(),
    text: safeText(message.text()),
    args,
    location: safeBody(message.location()),
  };
  if (argErrors.length) item.argument_collection_errors = argErrors;
  options.record("console", item);
  if (message.type() === "error" || message.type() === "warning") {
    options.addFailure({ kind: `console:${message.type()}`, ...item });
  }
}

async function captureRequestFailure(request, options) {
  const context = {
    url: safeUrl(request.url()),
    method: request.method(),
    resourceType: request.resourceType(),
  };
  const headers = await collect(
    "failed request headers",
    () => request.allHeaders(),
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
  { record, addFailure, pending = [], binaryArtifactDir } = {}
) {
  let binarySequence = 0;
  const options = {
    record,
    addFailure,
    binaryArtifactDir,
    nextBinaryArtifact: () => ++binarySequence,
  };
  page.on("console", (message) => {
    track(pending, "console capture", captureConsole(message, options), {}, addFailure);
  });
  page.on("pageerror", (error) => {
    addFailure({ kind: "pageerror", error: safeError(error) });
  });
  page.on("crash", () => {
    addFailure({
      kind: "page-crash",
      error: { name: "PageCrash", message: "The page crashed.", stack: "" },
    });
  });
  page.on("requestfailed", (request) => {
    try {
      track(
        pending,
        "failed request capture",
        captureRequestFailure(request, options),
        { url: safeUrl(request.url()), method: request.method() },
        addFailure
      );
    } catch (error) {
      addFailure({
        kind: "diagnostic-collection",
        operation: "failed request metadata",
        error: safeError(error),
      });
    }
  });
  page.on("response", (response) => {
    try {
      track(
        pending,
        "response capture",
        captureResponse(response, options),
        { url: safeUrl(response.url()), method: response.request().method() },
        addFailure
      );
    } catch (error) {
      addFailure({
        kind: "diagnostic-collection",
        operation: "response metadata",
        error: safeError(error),
      });
    }
  });
  return pending;
}
