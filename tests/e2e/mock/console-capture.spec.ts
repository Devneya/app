import { expect, test } from "@playwright/test";
import { installConsoleCapture } from "../console-capture.mjs";

test("retains a console message across navigation", async ({ page }) => {
  const calls: unknown[] = [];
  await installConsoleCapture(page, (payload) => calls.push(payload));

  await page.goto("/login");
  await page.evaluate(() => console.log("navigation-survival", { marker: "complete diagnostic value" }));
  await page.goto("/forgot-password");

  await expect.poll(() => JSON.stringify(calls)).toContain("navigation-survival");
  expect(JSON.stringify(calls)).toContain("complete diagnostic value");
});
