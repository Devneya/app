import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  cancelSubscription,
  createBillingPortal,
  deleteAccount,
  fetchUsage,
  fetchVirtualKey,
  logout,
  startSubscription,
  uncancelSubscription,
} from "@/api/account";
import { config } from "@/config";
import { MOCK_ACCESS_TOKEN } from "@/mocks/data";
import { server } from "@/mocks/server";

const accountBase = `${config.apiBaseUrl}/account`;

describe("account API response checks", () => {
  it("rejects a key response without the key consumed by the UI", async () => {
    const invalidPayload = { unexpected: "payload" };
    server.use(http.get(`${accountBase}/key`, () => HttpResponse.json(invalidPayload)));

    await expect(fetchVirtualKey(MOCK_ACCESS_TOKEN)).rejects.toMatchObject({
      message: "API key response was invalid.",
      cause: invalidPayload,
      responseBody: invalidPayload,
    });
  });

  it("preserves supported response fields beyond the fields validated by the client", async () => {
    server.use(
      http.get(`${accountBase}/key`, () =>
        HttpResponse.json({ key: "key_test", provider_field: "kept" })
      ),
      http.get(`${accountBase}/usage`, () =>
        HttpResponse.json({
          used: 1,
          limit: 10,
          subscription_status: "active",
          entitlement_status: "active",
          cancel_at_period_end: false,
          access_until: null,
          required_billing_action: "none",
          provider_field: "kept",
        })
      ),
      http.post(`${accountBase}/subscribe`, () =>
        HttpResponse.json({
          status: "checkout",
          checkout_url: "https://checkout.test",
          expires_at: "2026-09-08T00:00:00Z",
          provider_field: "kept",
        })
      ),
      http.post(`${accountBase}/subscribe/cancel`, () =>
        HttpResponse.json({
          status: "cancelled",
          cancel_at_period_end: true,
          access_until: "2026-09-08T00:00:00Z",
          provider_field: "kept",
        })
      ),
      http.post(`${accountBase}/billing/portal`, () =>
        HttpResponse.json({ portal_url: "https://portal.test", provider_field: "kept" })
      ),
      http.post(`${accountBase}/logout`, () =>
        HttpResponse.json({ status: "logged_out", provider_field: "kept" })
      ),
      http.delete(accountBase, () =>
        HttpResponse.json({ status: "deleted", provider_field: "kept" })
      )
    );

    await expect(fetchVirtualKey(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      key: "key_test",
      provider_field: "kept",
    });
    await expect(fetchUsage(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      used: 1,
      provider_field: "kept",
    });
    await expect(startSubscription(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      status: "checkout",
      provider_field: "kept",
    });
    await expect(cancelSubscription(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      status: "cancelled",
      provider_field: "kept",
    });
    await expect(createBillingPortal(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      portal_url: "https://portal.test",
      provider_field: "kept",
    });
    await expect(logout(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      status: "logged_out",
      provider_field: "kept",
    });
    await expect(deleteAccount(MOCK_ACCESS_TOKEN)).resolves.toMatchObject({
      status: "deleted",
      provider_field: "kept",
    });
  });

  it("rejects usage without the required access boundary", async () => {
    server.use(
      http.get(`${accountBase}/usage`, () =>
        HttpResponse.json({
          used: 0,
          limit: 10,
          subscription_status: "none",
          entitlement_status: "none",
          cancel_at_period_end: false,
          required_billing_action: "subscribe",
        })
      )
    );

    await expect(fetchUsage(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Usage response was invalid."
    );
  });

  it("rejects checkout and portal responses without usable URLs and expiry", async () => {
    const invalidPortalPayload = { portal_url: "javascript:alert(1)" };
    server.use(
      http.post(`${accountBase}/subscribe`, () =>
        HttpResponse.json({ status: "checkout", checkout_url: "https://checkout.test" })
      ),
      http.post(`${accountBase}/billing/portal`, () =>
        HttpResponse.json(invalidPortalPayload)
      )
    );

    await expect(startSubscription(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Subscription checkout expiry response was invalid."
    );
    await expect(createBillingPortal(MOCK_ACCESS_TOKEN)).rejects.toMatchObject({
      message: "Billing portal URL response was invalid.",
      responseBody: invalidPortalPayload,
      cause: expect.any(Error),
    });
  });

  it("rejects cancellation, logout, and deletion responses that do not verify completion", async () => {
    server.use(
      http.post(`${accountBase}/subscribe/cancel`, () => HttpResponse.json({ status: "cancelled" })),
      http.post(`${accountBase}/subscribe/uncancel`, () =>
        HttpResponse.json({ status: "active", cancel_at_period_end: false })
      ),
      http.post(`${accountBase}/logout`, () => HttpResponse.json({ status: "accepted" })),
      http.delete(accountBase, () => HttpResponse.json({ status: "accepted" }))
    );

    await expect(cancelSubscription(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Subscription cancellation response was invalid."
    );
    await expect(uncancelSubscription(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Subscription cancellation response was invalid."
    );
    await expect(logout(MOCK_ACCESS_TOKEN)).rejects.toThrow("Logout response was invalid.");
    await expect(deleteAccount(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Account deletion response was invalid."
    );
  });
});
