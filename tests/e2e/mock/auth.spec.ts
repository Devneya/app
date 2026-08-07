import { test, expect } from "@playwright/test";
import { MOCK_USER, MOCK_VIRTUAL_KEY } from "../fixtures";

test.describe("auth flow", () => {
  test("login page snapshot", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: /forgot password/i })).toBeVisible();
    await expect(page).toHaveScreenshot("login-page.png");
  });

  test("forgot password page snapshot", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Forgot password" })).toBeVisible();
    await expect(page).toHaveScreenshot("forgot-password-page.png");
  });

  test("sign in and view dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Account", { exact: true })).toBeVisible();
    await expect(page.getByText(MOCK_VIRTUAL_KEY)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard-unsubscribed.png");
  });

  test("subscribe navigates to Dodo checkout", async ({ page }) => {
    await page.route("https://checkout.dodopayments.com/**", (route) =>
      route.fulfill({ status: 200, body: "mock dodo checkout" }),
    );

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const checkoutNavigation = page.waitForURL(/checkout\.dodopayments\.com/);
    await page.getByRole("button", { name: "Subscribe" }).click();
    await checkoutNavigation;
  });

  test("logout returns to login", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("change password signs out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();

    await page.getByLabel(/current password/i).fill(MOCK_USER.password);
    await page.getByLabel(/^new password/i).fill("password456");
    await page.getByLabel(/confirm new password/i).fill("password456");
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/password updated/i)).toBeVisible();
  });
});
