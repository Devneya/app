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

  test("subscribe redirects to checkout", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(MOCK_USER.email);
    await page.getByLabel("Password").fill(MOCK_USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.getByRole("button", { name: "Subscribe" }).click();
    await expect(page.getByRole("heading", { name: "Mock checkout" })).toBeVisible();
    await expect(page).toHaveURL(/\/mock-checkout$/);
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
