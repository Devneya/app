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
    server.use(http.get(`${accountBase}/key`, () => HttpResponse.json({})));

    await expect(fetchVirtualKey(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "API key response was invalid."
    );
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
    server.use(
      http.post(`${accountBase}/subscribe`, () =>
        HttpResponse.json({ status: "checkout", checkout_url: "https://checkout.test" })
      ),
      http.post(`${accountBase}/billing/portal`, () =>
        HttpResponse.json({ portal_url: "javascript:alert(1)" })
      )
    );

    await expect(startSubscription(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Subscription checkout expiry response was invalid."
    );
    await expect(createBillingPortal(MOCK_ACCESS_TOKEN)).rejects.toThrow(
      "Billing portal URL response was invalid."
    );
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
