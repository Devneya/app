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

  test("signup shows check your email", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign up" }).click();
    await page.getByLabel(/email/i).fill("new@example.com");
    await page.getByLabel(/^password/i).fill("password123");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText(/new@example.com/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "LLM inference" })).toHaveCount(0);
  });

  test("sign in and view inference", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("[Devneya]")).toBeVisible();
    await expect(page.getByRole("link", { name: "LLM inference" })).toBeVisible();
    await expect(page.getByText(MOCK_VIRTUAL_KEY)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Available models" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Available models" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`Account menu: ${MOCK_USER.email}`, "i") })
    ).toBeVisible();
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

  test("logout from account menu", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page
      .getByRole("button", { name: new RegExp(`Account menu: ${MOCK_USER.email}`, "i") })
      .click();
    await page.getByRole("menuitem", { name: "Profile" }).click();
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByRole("link", { name: "LLM inference" })).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(`Account menu: ${MOCK_USER.email}`, "i") })
      .click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("change password signs out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(MOCK_USER.email);
    await page.getByLabel(/^password/i).fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page
      .getByRole("button", { name: new RegExp(`Account menu: ${MOCK_USER.email}`, "i") })
      .click();
    await page.getByRole("menuitem", { name: "Profile" }).click();
    await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();

    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByLabel(/current password/i).fill(MOCK_USER.password);
    await page.getByLabel(/^new password/i).fill("password456");
    await page.getByLabel(/confirm new password/i).fill("password456");
    await page.getByRole("button", { name: "Save new password" }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/password updated/i)).toBeVisible();
  });
});
