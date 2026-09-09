import { expect, test } from "@playwright/test";
import { installConsoleCapture } from "../console-capture.mjs";
import { safeBody } from "../diagnostics.mjs";

test("snapshots structured console arguments before navigation", async ({ page }, testInfo) => {
  const calls: unknown[] = [];
  try {
  await installConsoleCapture(page, (payload) => calls.push(payload));
  await page.goto("/login");

  const originalConsole = page.waitForEvent("console", {
    predicate: (message) => message.type() === "error" && message.text().includes("before navigation"),
  });
  await page.evaluate(() => {
    const nested: Record<string, unknown> = { value: "kept" };
    nested.self = nested;
    const error = new Error("before navigation");
    error.cause = new TypeError("nested cause");
    Object.assign(error, { status: 502, responseHeaders: new Headers({ "x-request-id": "request-before-navigation", authorization: "opaque-private-header" }) });
    const aggregate = new AggregateError([new Error("aggregate child")], "aggregate");
    console.error("before navigation", error, aggregate, error, { nested });
    const reused = { value: "same object" };
    const list = ["first"];
    list.label = "extra property";
    function handler() {
      return "Bearer diagnostic-token";
    }
    console.log("shape", { first: reused, second: reused, list, api_key: "diagnostic-key" }, handler);
  });
  await originalConsole;

  await expect.poll(() => calls.some((value) => {
    const item = value as { kind?: string; method?: string; args?: unknown[] };
    return item.kind === "console-call" && item.method === "error" && item.args?.[0] === "before navigation";
  })).toBe(true);

  await page.goto("/forgot-password");
  const capture = calls.find((value) => {
    const item = value as { kind?: string; method?: string; args?: unknown[] };
    return item.kind === "console-call" && item.method === "error" && item.args?.[0] === "before navigation";
  }) as { args: unknown[] } | undefined;
  expect(capture).toBeDefined();
  expect(JSON.stringify(capture)).toContain("nested cause");
  expect(JSON.stringify(capture)).toContain("aggregate child");
  expect(JSON.stringify(capture)).toContain('"status":502');
  expect(JSON.stringify(capture)).toContain("request-before-navigation");
  expect(JSON.stringify(safeBody(capture))).not.toContain("opaque-private-header");
  expect(JSON.stringify(capture)).toContain("circular");
  expect(capture?.args[1]).toEqual(capture?.args[3]);
  expect(JSON.stringify(capture?.args[3])).not.toContain("circular-error");
  const errorCapture = capture as { frameUrl?: string; location?: string; callStack?: string };
  expect(errorCapture.frameUrl).toContain("/login");
  expect(errorCapture.location).toContain("/login");
  expect(errorCapture.callStack).toContain("console.value");

  const shape = calls.find((value) => {
    const item = value as { kind?: string; method?: string; args?: unknown[] };
    return item.kind === "console-call" && item.method === "log" && item.args?.[0] === "shape";
  }) as { args: unknown[] } | undefined;
  expect(shape).toBeDefined();
  const shapeObject = shape?.args[1] as { properties: Record<string, unknown> };
  expect(shapeObject.properties.first).toEqual(shapeObject.properties.second);
  const encodedList = shapeObject.properties.list as { properties: Record<string, unknown> };
  expect(encodedList.properties.label).toBe("extra property");
  expect((shape?.args[2] as { source: string }).source).toContain("Bearer diagnostic-token");
  const safeShape = safeBody(shape);
  expect(JSON.stringify(safeShape)).not.toContain("diagnostic-key");
  expect(JSON.stringify(safeShape)).not.toContain("Bearer diagnostic-token");

  await page.evaluate(() => {
    console.log({ get broken() { throw new Error("console property read failed"); }, retained: "still captured" });
  });
  await expect.poll(() => calls.some(value => (value as { kind?: string }).kind === "console-capture-error")).toBe(true);
  expect(JSON.stringify(calls)).toContain("console property read failed");
  expect(JSON.stringify(calls)).toContain("still captured");
  } finally {
    await testInfo.attach("console-capture-output", {
      body: JSON.stringify(safeBody(calls), null, 2),
      contentType: "application/json",
    });
  }
});
