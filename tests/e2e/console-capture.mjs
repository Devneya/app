/* global console */

export const CONSOLE_CAPTURE_BINDING = "__devneyaCaptureConsoleCall";

const CONSOLE_METHODS = [
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "profile",
  "profileEnd",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
  "trace",
  "warn",
];

function installInPage(bindingName, methods) {
  const captureState = () => Object.assign(new WeakSet(), { failures: [] });
  const noteFailure = (error, seen) => seen.failures.push(formatFailure(error));
  const setProperty = (object, key, value) => {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  };

  const formatError = (error, seen) => {
    if (seen.has(error)) return { type: "circular-error" };
    seen.add(error);
    try {
      const output = {
        type: "error",
        name: String(error?.name || "Error"),
        message: String(error?.message || error),
        stack: String(error?.stack || ""),
      };
      try {
        if (error?.cause !== undefined) output.cause = formatValue(error.cause, seen);
      } catch (causeError) {
        noteFailure(causeError, seen);
        output.causeError = formatError(causeError, seen);
      }
      try {
        if (Array.isArray(error?.errors)) output.errors = error.errors.map((item) => formatValue(item, seen));
      } catch (errorsError) {
        noteFailure(errorsError, seen);
        output.errorsError = formatError(errorsError, seen);
      }
      try {
        for (const key of Object.keys(error)) {
          if (key !== "cause" && key !== "errors" && !(key in output)) {
            try {
              setProperty(output, key, formatValue(error[key], seen));
            } catch (propertyError) {
              noteFailure(propertyError, seen);
              setProperty(output, key, { type: "property-error", error: formatError(propertyError, seen) });
            }
          }
        }
      } catch (propertiesError) {
        noteFailure(propertiesError, seen);
        output.propertiesError = formatError(propertiesError, seen);
      }
      return output;
    } finally {
      seen.delete(error);
    }
  };

  const formatValue = (value, seen) => {
    if (value === null) return null;
    if (value === undefined) return { type: "undefined" };
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : { type: "number", value: String(value) };
    }
    if (typeof value === "bigint") return { type: "bigint", value: String(value) };
    if (typeof value === "symbol") return { type: "symbol", value: String(value) };
    if (typeof value === "function") {
      try {
        return { type: "function", name: value.name || "", source: String(value) };
      } catch (error) {
        noteFailure(error, seen);
        return { type: "function", name: value.name || "", sourceError: formatFailure(error) };
      }
    }
    if (seen.has(value)) return { type: "circular" };
    if (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") {
      return formatError(value, seen);
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const items = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            items[index] = { type: "array-hole" };
            continue;
          }
          try {
            items[index] = formatValue(value[index], seen);
          } catch (error) {
            noteFailure(error, seen);
            items[index] = { type: "property-error", error: formatError(error, seen) };
          }
        }
        const properties = {};
        for (const key of Object.keys(value)) {
          if (/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length) continue;
          try {
            setProperty(properties, key, formatValue(value[key], seen));
          } catch (error) {
            noteFailure(error, seen);
            setProperty(properties, key, { type: "property-error", error: formatError(error, seen) });
          }
        }
        return { type: "array", items, properties };
      }
      if (value instanceof Date) return { type: "date", value: value.toISOString() };
      if (value instanceof RegExp) return { type: "regexp", value: String(value) };
      if (value instanceof globalThis.Headers) {
        return { type: "headers", entries: [...value.entries()].map(([name, value]) => ({ name, value })) };
      }
      if (value instanceof Map) {
        return { type: "map", entries: [...value.entries()].map(([key, item]) => [formatValue(key, seen), formatValue(item, seen)]) };
      }
      if (value instanceof Set) return { type: "set", values: [...value].map((item) => formatValue(item, seen)) };
      const output = { type: Object.prototype.toString.call(value).slice(8, -1), properties: {} };
      for (const key of Object.keys(value)) {
        try {
          setProperty(output.properties, key, formatValue(value[key], seen));
        } catch (error) {
          noteFailure(error, seen);
          setProperty(output.properties, key, { type: "property-error", error: formatError(error, seen) });
        }
      }
      return output;
    } catch (error) {
      noteFailure(error, seen);
      return { type: "object", propertiesError: formatError(error, seen) };
    } finally {
      seen.delete(value);
    }
  };

  const formatFailure = (error) => {
    try {
      return formatError(error, captureState());
    } catch {
      return { type: "error", name: "Error", message: String(error), stack: "" };
    }
  };

  const surfaceBindingFailure = (error) => {
    globalThis.setTimeout(() => {
      throw error;
    }, 0);
  };

  const report = (payload) => {
    const hook = globalThis[bindingName];
    if (typeof hook !== "function") {
      surfaceBindingFailure(new Error(`Console capture binding ${bindingName} is unavailable.`));
      return;
    }
    try {
      const result = hook(payload);
      if (result && typeof result.then === "function") result.catch(surfaceBindingFailure);
    } catch (error) {
      surfaceBindingFailure(error);
    }
  };

  const capture = (method, args) => {
    try {
      const seen = captureState();
      let location;
      try {
        location = globalThis.location?.href || "";
      } catch (error) {
        noteFailure(error, seen);
        location = { collectionError: formatFailure(error) };
      }
      report({
        kind: "console-call",
        method,
        type: method === "warn" ? "warning" : method,
        args: args.map((value) => formatValue(value, seen)),
        location,
        callStack: String(new Error().stack || ""),
        at: new Date().toISOString(),
      });
      if (seen.failures.length) {
        report({ kind: "console-capture-error", method, errors: seen.failures, at: new Date().toISOString() });
      }
    } catch (error) {
      report({
        kind: "console-capture-error",
        method,
        error: formatFailure(error),
        at: new Date().toISOString(),
      });
    }
  };

  for (const method of methods) {
    try {
      const original = console[method];
      if (typeof original !== "function") continue;
      Object.defineProperty(console, method, {
        configurable: true,
        writable: true,
        value: function (...args) {
          try {
            return original.apply(this, args);
          } finally {
            capture(method, args);
          }
        },
      });
    } catch (error) {
      report({
        kind: "console-capture-install-error",
        method,
        error: formatFailure(error),
        at: new Date().toISOString(),
      });
    }
  }
}

export async function installConsoleCapture(page, onCapture) {
  await page.exposeBinding(CONSOLE_CAPTURE_BINDING, (source, payload) => {
    const frameUrl = source.frame.url();
    const frameName = source.frame.name();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return onCapture({
        kind: "console-capture-error",
        error: { name: "Error", message: "Console capture binding received an invalid payload.", stack: "" },
        payload,
        frameUrl,
        frameName,
      });
    }
    return onCapture({ ...payload, frameUrl, frameName });
  });
  await page.addInitScript({
    content: `(${installInPage.toString()})(${JSON.stringify(CONSOLE_CAPTURE_BINDING)}, ${JSON.stringify(CONSOLE_METHODS)})`,
  });
}
