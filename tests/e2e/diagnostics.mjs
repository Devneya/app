/* global Buffer, Headers, Response, TextDecoder, URL, URLSearchParams */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installConsoleCapture } from "./console-capture.mjs";
import { captureChildSessions } from "./frame-sessions.mjs";
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
    settled.push(...(await Promise.allSettled(batch)));
    drained += batch.length;
  }
  return settled;
}

function responseIsMainFrame(response, addFailure) {
  if (typeof response.frame !== "function") return undefined;
  try {
    const frame = response.frame();
    return typeof frame?.parentFrame === "function" ? frame.parentFrame() === null : undefined;
  } catch (error) {
    addFailure({
      kind: "diagnostic-collection",
      operation: "response frame metadata",
      error: safeError(error),
    });
    return undefined;
  }
}

function createCdpStreamCapture(session, rootFrameId, { pending, record, addFailure, binaryArtifactDir, nextBinaryArtifact }) {
  const entries = new Map();
  const listeners = new Map();

  const listen = (event, listener) => {
    session.on(event, listener);
    listeners.set(event, listener);
  };

  const retainEntryError = (entry, error) => {
    entry.errors.push(error);
  };

  const addEntryFailure = (entry, error, operation = "CDP response stream") => {
    retainEntryError(entry, error);
    addFailure({
      kind: "diagnostic-collection",
      operation,
      url: safeUrl(entry.response?.url ?? entry.url),
      method: entry.method,
      ...(entry.response?.status !== undefined ? { status: entry.response.status } : {}),
      error: safeError(error),
    });
  };

  const finish = (entry, status) => {
    if (entry.settled) return;
    entry.settled = true;
    entry.finished = status === "finished";
    entry.loadingFailed = status === "failed";
    entry.resolveDone();
  };

  const emitEntry = async entry => {
    await entry.streamTask;
    const bytes = entry.fallbackBody ?? Buffer.concat([entry.buffered, ...entry.chunks]);
    const url = safeUrl(entry.response?.url ?? entry.url);
    const context = {
      url,
      method: entry.method,
      ...(entry.response?.status !== undefined ? { status: entry.response.status } : {}),
      ...(entry.response?.fromServiceWorker !== undefined
        ? { fromServiceWorker: entry.response.fromServiceWorker }
        : {}),
    };
    try {
      const responseHeaders = entry.response?.headers ?? {};
      const serialized = await serializeResponseBody(bytes, responseHeaders, context, {
        binaryArtifactDir,
        binaryPrefix: "cdp-response",
        nextBinaryArtifact,
        addFailure,
      });
      const request = {
        postData: () => entry.postData ?? null,
        postDataBuffer: () => entry.postData ?? null,
      };
      const requestData = await collect(
        "request body",
        () => requestBody(request, entry.requestHeaders ?? {}),
        context,
        addFailure,
      );
      const item = {
        ...(entry.response?.status !== undefined ? { status: entry.response.status } : {}),
        method: entry.method,
        resourceType: entry.resourceType ?? "unknown",
        url,
        requestHeaders: safeHeaders(entry.requestHeaders ?? {}),
        headers: safeHeaders(responseHeaders),
        requestBody: requestData,
        body: entry.redirect ? { unavailable: true, reason: "Chromium does not expose redirect response bodies; the request ID is reused for the next hop", observedStreamBytes: serialized.body }
          : !entry.bodyCaptureComplete && entry.errors.length && bytes.byteLength === 0
          ? { collection_error: entry.errors.map(error => safeError(error)), partialByteLength: 0 }
          : serialized.body,
        mainFrame: entry.frameId === rootFrameId,
        ...(context.fromServiceWorker !== undefined
          ? { fromServiceWorker: context.fromServiceWorker }
          : {}),
        captureSource: "cdp-stream",
        streamComplete: entry.finished && !entry.loadingFailed && entry.streamMethodSucceeded === true,
        bodyCaptureComplete: entry.bodyCaptureComplete === true && !entry.loadingFailed,
        availableBodyCaptureComplete: entry.bodyCaptureComplete === true && (entry.finished || entry.loadingError !== undefined),
        bodyCaptureMethod: entry.bodyCaptureMethod,
        cdpStream: {
          requestId: entry.requestId,
          frameId: entry.frameId,
          bufferedBytes: entry.buffered.byteLength,
          chunkCount: entry.chunks.length,
          byteLength: bytes.byteLength,
          ...(entry.response?.mimeType ? { mimeType: entry.response.mimeType } : {}),
          ...(entry.encodedDataLength !== undefined ? { encodedDataLength: entry.encodedDataLength } : {}),
          ...(entry.errors.length ? { errors: entry.errors.map(error => safeError(error)) } : {}),
        },
      };
      record("http", item);
    } catch (error) {
      addFailure({
        kind: "diagnostic-collection",
        operation: "CDP response record",
        ...context,
        error: safeError(error),
      });
    }
  };

  const createEntry = (event) => {
    let resolveDone;
    const entry = {
      requestId: event.requestId,
      frameId: event.frameId,
      url: event.request?.url ?? "",
      method: event.request?.method ?? "GET",
      resourceType: event.type,
      requestHeaders: event.request?.headers ?? {},
      postData: event.request?.postData,
      chunks: [],
      buffered: Buffer.alloc(0),
      errors: [],
      settled: false,
      finished: false,
      loadingFailed: false,
      done: new Promise(resolve => { resolveDone = resolve; }),
      resolveDone,
    };
    entries.set(entry.requestId, entry);
    let streamCommand;
    try {
      streamCommand = session.send("Network.streamResourceContent", { requestId: entry.requestId });
    } catch (error) {
      streamCommand = Promise.reject(error);
    }
    entry.streamTask = Promise.resolve(streamCommand)
      .then(result => {
        if (typeof result?.bufferedData !== "string") {
          const error = new Error("Network.streamResourceContent returned no bufferedData string");
          error.cause = safeBody(result);
          throw error;
        }
        entry.buffered = Buffer.from(result.bufferedData, "base64");
        entry.streamMethodSucceeded = true;
        entry.bodyCaptureComplete = true;
        entry.bodyCaptureMethod = "Network.streamResourceContent";
      })
      .catch(async error => {
        await entry.done;
        if (entry.redirect || entry.method === "HEAD" || [204, 304].includes(entry.response?.status)) {
          retainEntryError(entry, error);
          entry.bodyCaptureComplete = !entry.redirect;
          entry.bodyCaptureMethod = "HTTP bodyless response";
          record("capture-method", { operation: "CDP response stream", requestId: entry.requestId,
            url: safeUrl(entry.url), error: safeError(error), reason: entry.redirect ? "redirect body unavailable in Chromium" : "HTTP response has no body" });
          return;
        }
        const alreadyFinished = /Request with the provided ID has already finished loading/i.test(error?.message ?? "");
        if (!alreadyFinished) {
          addEntryFailure(entry, error);
          return;
        }
        retainEntryError(entry, error);
        try {
          const result = await session.send("Network.getResponseBody", { requestId: entry.requestId });
          if (typeof result?.body !== "string" || typeof result?.base64Encoded !== "boolean") {
            const keys = result && typeof result === "object" ? Object.keys(result).join(", ") : typeof result;
            const error = new Error(`Network.getResponseBody returned no complete body result (keys: ${keys})`);
            error.cause = safeBody(result);
            throw error;
          }
          entry.fallbackBody = Buffer.from(result.body, result.base64Encoded ? "base64" : "utf8");
          entry.bodyCaptureComplete = true;
          entry.bodyCaptureMethod = "Network.getResponseBody";
          record("capture-method", {
            operation: "CDP response stream",
            fallback: "Network.getResponseBody",
            requestId: entry.requestId,
            url: safeUrl(entry.url),
            method: entry.method,
            error: safeError(error),
          });
        } catch (fallbackError) {
          addFailure({
            kind: "diagnostic-collection",
            operation: "CDP response stream",
            url: safeUrl(entry.response?.url ?? entry.url),
            method: entry.method,
            ...(entry.response?.status !== undefined ? { status: entry.response.status } : {}),
            error: safeError(error),
          });
          addEntryFailure(entry, fallbackError, "CDP completed-body fallback");
        }
      });
    entry.emitTask = Promise.all([entry.streamTask, entry.done]).then(() => emitEntry(entry));
    track(pending, "CDP response stream", entry.emitTask, { url: safeUrl(entry.url), method: entry.method }, addFailure);
    return entry;
  };

  listen("Network.requestWillBeSent", event => {
    // Blob bytes are captured at creation, not read from the network body store.
    if (event.request?.url?.startsWith("blob:")) return;
    // Cross-process navigation and initial scripts belong to Playwright's
    // existing session; they can start before this session enables Network.
    if (["Document", "Script"].includes(event.type) && event.frameId !== rootFrameId) return;
    const previous = entries.get(event.requestId);
    if (previous && !previous.settled) {
      if (event.redirectResponse) {
        previous.response = {
          url: event.redirectResponse.url ?? previous.url,
          status: event.redirectResponse.status,
          headers: event.redirectResponse.headers ?? {},
          mimeType: event.redirectResponse.mimeType,
          fromServiceWorker: event.redirectResponse.fromServiceWorker,
        };
        previous.redirect = true;
        finish(previous, "failed");
      } else {
        addEntryFailure(previous, new Error("CDP request identifier was reused before its stream finished"));
        finish(previous, "failed");
      }
    }
    createEntry(event);
  });
  listen("Network.responseReceived", event => {
    const entry = entries.get(event.requestId);
    if (!entry || entry.settled) return;
    entry.response = {
      url: event.response?.url ?? entry.url,
      status: event.response?.status,
      headers: event.response?.headers ?? {},
      mimeType: event.response?.mimeType,
      fromServiceWorker: event.response?.fromServiceWorker,
    };
    entry.resourceType = event.type ?? entry.resourceType;
  });
  listen("Network.dataReceived", event => {
    const entry = entries.get(event.requestId);
    if (!entry || entry.settled) return;
    if (typeof event.data === "string") entry.chunks.push(Buffer.from(event.data, "base64"));
  });
  listen("Network.loadingFinished", event => {
    const entry = entries.get(event.requestId);
    if (!entry || entry.settled) return;
    entry.encodedDataLength = event.encodedDataLength;
    finish(entry, "finished");
  });
  listen("Network.loadingFailed", event => {
    const entry = entries.get(event.requestId);
    if (!entry || entry.settled) return;
    const error = new Error(event.errorText || "Network loading failed");
    if (event.canceled !== undefined) error.canceled = event.canceled;
    entry.loadingError = error;
    retainEntryError(entry, error);
    addFailure({ kind: "requestfailed", operation: "CDP response loading",
      requestId: entry.requestId, url: safeUrl(entry.url), method: entry.method, error: safeError(error) });
    finish(entry, "failed");
  });

  const close = () => {
    for (const [event, listener] of listeners) {
      if (typeof session.off === "function") session.off(event, listener);
      else session.removeListener(event, listener);
    }
    for (const entry of entries.values()) {
      if (!entry.settled) {
        addEntryFailure(entry, new Error("CDP response stream stopped before loading finished"), "CDP response stream teardown");
        finish(entry, "failed");
      }
    }
  };

  return { close, entries };
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
  const session = await page.context().newCDPSession(page);
  const frameTree = await session.send("Page.getFrameTree");
  const rootFrameId = frameTree?.frameTree?.frame?.id;
  if (typeof rootFrameId !== "string" || !rootFrameId) {
    throw new Error("Page.getFrameTree returned no root frame ID", { cause: safeBody(frameTree) });
  }
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  let binarySequence = 0;
  const options = {
    pending,
    record,
    addFailure,
    binaryArtifactDir,
    nextBinaryArtifact: () => ++binarySequence,
  };
  const cdpStreams = createCdpStreamCapture(session, rootFrameId, options);
  const reportFailure = error => addFailure({
    kind: "diagnostic-collection", operation: "child CDP session", error: safeError(error),
  });
  const configureChild = child => {
    const streams = createCdpStreamCapture(child, rootFrameId, options);
    let closeChildren = () => {};
    track(pending, "configure child CDP capture", (async () => {
      await child.send("Network.enable");
      await child.send("Network.setCacheDisabled", { cacheDisabled: true });
      closeChildren = await captureChildSessions(child, configureChild, reportFailure);
    })(), {}, addFailure);
    return () => { closeChildren(); streams.close(); };
  };
  const closeChildren = await captureChildSessions(session, configureChild, reportFailure);
  const closeRoot = cdpStreams.close;
  cdpStreams.close = () => { closeChildren(); closeRoot(); };

  return {
    browserCache: "disabled",
    cacheCoverage: "not-covered",
    cdpBodyCapture: "streamResourceContent",
    cdpBodyCoverage: "page/frame/worker streams; Playwright captures child network documents and scripts; blob bytes captured at creation",
    rootFrameId,
    cdpStreams,
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

export const MOCK_RESPONSE_CAPTURE_HOOK = "__devneyaCaptureMockResponse";

export function missingMockResponses(observations) {
  const counts = new Map();
  for (const item of observations) {
    if (item.kind !== "http") continue;
    const source = item.captureSource === "msw-response:mocked";
    if (!source && item.body?.captureSource !== "msw-response:mocked") continue;
    const key = JSON.stringify([item.method, item.url, item.status]);
    const count = counts.get(key) ?? { response: [item.method, item.url, item.status], observedResponses: 0, capturedBodies: 0 };
    count[source ? "capturedBodies" : "observedResponses"] += 1;
    counts.set(key, count);
  }
  return [...counts.values()].filter(count => count.observedResponses !== count.capturedBodies);
}

export function missingCdpStreamResponses(observations) {
  const blobIds = new Set(observations.filter(item => item.kind === "blob-source").map(item => item.blobId));
  const missingBlobs = observations.filter(item => item.kind === "http" && item.body?.captureSource === "blob-source" && !blobIds.has(item.body.blobId));
  const counts = new Map();
  for (const item of observations) {
    if (item.kind !== "http") continue;
    if (item.status >= 300 && item.status <= 399) continue;
    const source = item.captureSource === "cdp-stream";
    const placeholder = item.body?.captureSource === "cdp-stream";
    if (!source && !placeholder) continue;
    const key = JSON.stringify([item.method, item.url, item.status]);
    const count = counts.get(key) ?? {
      response: [item.method, item.url, item.status],
      observedResponses: 0,
      capturedBodies: 0,
    };
    if (placeholder) count.observedResponses += 1;
    if (source && (item.bodyCaptureComplete === true || item.availableBodyCaptureComplete === true)) count.capturedBodies += 1;
    counts.set(key, count);
  }
  return [...counts.values()]
    .filter(count => count.observedResponses > 0)
    .filter(count => count.observedResponses > count.capturedBodies)
    .concat(missingBlobs.map(item => ({ response: [item.method, item.url, item.status], observedResponses: 1, capturedBodies: 0 })));
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
  const url = safeUrl(response.url());
  const mainFrame = responseIsMainFrame(response, options.addFailure);
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
    () => readHeaders(response),
    context,
    options.addFailure
  );
  const redirectResponse = context.status >= 300 && context.status <= 399;
  const responseBodyTask = options.mockResponseBodiesOrigin && context.fromServiceWorker &&
    new URL(response.url()).origin === options.mockResponseBodiesOrigin
    ? Promise.resolve({ captureSource: "msw-response:mocked" })
    : options.cdpStreams && response.url().startsWith("blob:")
    ? Promise.resolve({ captureSource: "blob-source", blobId: createHash("sha256").update(response.url()).digest("hex") })
    : redirectResponse
    ? Promise.resolve({
        unavailable: true,
        reason: "Playwright does not expose response bodies for 3xx responses",
      })
    : options.cdpStreams && (mainFrame === true || !["document", "script"].includes(request.resourceType()))
    ? Promise.resolve({ captureSource: "cdp-stream" })
    : collect(
        "response body",
        () => (typeof response.body === "function" ? response.body() : response.text()),
        context,
        options.addFailure
      );
  const [responseHeaders, responseBody] = await Promise.all([responseHeadersTask, responseBodyTask]);
  const serialized = await serializeResponseBody(responseBody, responseHeaders, context, options);
  const body = serialized.body;
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
  const item = {
    status: response.status(),
    method: request.method(),
    resourceType: request.resourceType(),
    url,
    requestHeaders: safeHeaders(requestHeaders),
    headers: safeHeaders(responseHeaders),
    requestBody: requestData,
    body,
    ...(mainFrame !== undefined ? { mainFrame } : {}),
    ...(context.fromServiceWorker !== undefined
      ? { fromServiceWorker: context.fromServiceWorker }
      : {}),
  };
  options.record("http", item);
  if (response.status() >= 400) options.addFailure({ kind: "http", ...item });
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
  if (message.text() === "Blob source capture failed") {
    options.addFailure({ kind: "diagnostic-collection", operation: "blob source binding", ...item });
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
  { record, addFailure, pending = [], binaryArtifactDir, mockResponseBodiesOrigin, cdpStreams } = {}
) {
  let binarySequence = 0;
  const options = {
    record,
    addFailure,
    binaryArtifactDir,
    mockResponseBodiesOrigin,
    cdpStreams,
    nextBinaryArtifact: () => ++binarySequence,
  };
  const listeners = new Map();
  const listen = (event, listener) => {
    page.on(event, listener);
    listeners.set(event, listener);
  };
  listen("console", (message) => {
    track(pending, "console capture", captureConsole(message, options), {}, addFailure);
  });
  listen("pageerror", (error) => {
    addFailure({ kind: "pageerror", error: safeError(error) });
  });
  listen("crash", () => {
    addFailure({
      kind: "page-crash",
      error: { name: "PageCrash", message: "The page crashed.", stack: "" },
    });
  });
  listen("requestfailed", (request) => {
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
  listen("response", (response) => {
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
  const removeListeners = () => {
    for (const [event, listener] of listeners) {
      page.off(event, listener);
    }
  };
  return removeListeners;
}
