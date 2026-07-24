import { test, expect } from "@playwright/test";
import { MOCK_USER, MOCK_VIRTUAL_KEY } from "../fixtures";

test.describe("auth flow", () => {
  test("login page snapshot", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Devneya" })).toBeVisible();
    await expect(page).toHaveScreenshot("login-page.png");
  });

  test("sign in and view dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(MOCK_USER.email);
    await page.getByLabel("Password").fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Devneya Account")).toBeVisible();
    await expect(page.getByText(MOCK_VIRTUAL_KEY)).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard-unsubscribed.png");
  });

  test("subscribe navigates to Dodo checkout", async ({ page }) => {
    await page.route("https://checkout.dodopayments.com/**", (route) =>
      route.fulfill({ status: 200, body: "mock dodo checkout" }),
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill(MOCK_USER.email);
    await page.getByLabel("Password").fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const checkoutNavigation = page.waitForURL(/checkout\.dodopayments\.com/);
    await page.getByRole("button", { name: "Subscribe" }).click();
    await checkoutNavigation;
  });

  test("logout returns to login", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(MOCK_USER.email);
    await page.getByLabel("Password").fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Devneya" })).toBeVisible();
  });
});
