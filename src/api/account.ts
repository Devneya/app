import type {
  CancelSubscriptionResponse,
  KeyResponse,
  SubscribeResponse,
  SubscriptionStatus,
  UsageResponse,
} from "@/api/types";
import { throwApiRequestError } from "@/api/errors";
import { config } from "@/config";

const subscriptionStatuses: SubscriptionStatus[] = [
  "none",
  "pending",
  "active",
  "past_due",
  "cancelled",
  "expired",
  "review_required",
];

const billingActions: UsageResponse["required_billing_action"][] = [
  "subscribe",
  "none",
  "uncancel",
  "update_payment",
  "contact_support",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidResponse(name: string): Error {
  return new Error(`${name} response was invalid.`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse(name);
  }
  return value;
}

function requiredUrl(value: unknown, name: string): string {
  const url = requiredString(value, name).trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported URL scheme");
    }
  } catch {
    throw invalidResponse(name);
  }
  return url;
}

function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === "string" && subscriptionStatuses.includes(value as SubscriptionStatus);
}

function isBillingAction(value: unknown): value is UsageResponse["required_billing_action"] {
  return typeof value === "string" && billingActions.includes(value as UsageResponse["required_billing_action"]);
}

function parseCancellation(value: unknown): CancelSubscriptionResponse {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !value.status.trim() ||
    typeof value.cancel_at_period_end !== "boolean" ||
    !(value.access_until === null || typeof value.access_until === "string")
  ) {
    throw invalidResponse("Subscription cancellation");
  }
  return {
    status: value.status,
    cancel_at_period_end: value.cancel_at_period_end,
    access_until: value.access_until,
  };
}

async function apiFetch<T>(
  path: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const resp = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!resp.ok) {
    await throwApiRequestError(resp);
  }
  return resp.json() as Promise<T>;
}

export function fetchVirtualKey(accessToken: string): Promise<KeyResponse> {
  return apiFetch<unknown>("/account/key", accessToken).then((value) => {
    if (!isRecord(value)) {
      throw invalidResponse("API key");
    }
    return { key: requiredString(value.key, "API key") };
  });
}

export async function fetchUsage(accessToken: string): Promise<UsageResponse> {
  const value = await apiFetch<unknown>("/account/usage", accessToken);
  if (!isRecord(value)) {
    throw invalidResponse("Usage");
  }
  if (
    typeof value.used !== "number" ||
    !Number.isFinite(value.used) ||
    typeof value.limit !== "number" ||
    !Number.isFinite(value.limit) ||
    !isSubscriptionStatus(value.subscription_status) ||
    !isSubscriptionStatus(value.entitlement_status) ||
    typeof value.cancel_at_period_end !== "boolean" ||
    !isBillingAction(value.required_billing_action) ||
    !(value.access_until === null || typeof value.access_until === "string")
  ) {
    throw invalidResponse("Usage");
  }
  return {
    used: value.used,
    limit: value.limit,
    subscription_status: value.subscription_status,
    entitlement_status: value.entitlement_status,
    cancel_at_period_end: value.cancel_at_period_end,
    access_until: value.access_until,
    required_billing_action: value.required_billing_action,
  };
}

export async function startSubscription(accessToken: string): Promise<SubscribeResponse> {
  const value = await apiFetch<unknown>("/account/subscribe", accessToken, {
    method: "POST",
  });
  if (!isRecord(value) || value.status !== "checkout") {
    throw invalidResponse("Subscription");
  }
  return {
    status: "checkout",
    checkout_url: requiredUrl(value.checkout_url, "Subscription checkout URL"),
    expires_at: requiredString(value.expires_at, "Subscription checkout expiry"),
  };
}

export function cancelSubscription(
  accessToken: string
): Promise<CancelSubscriptionResponse> {
  return apiFetch<unknown>("/account/subscribe/cancel", accessToken, {
    method: "POST",
  }).then(parseCancellation);
}

export function uncancelSubscription(
  accessToken: string
): Promise<CancelSubscriptionResponse> {
  return apiFetch<unknown>("/account/subscribe/uncancel", accessToken, {
    method: "POST",
  }).then(parseCancellation);
}

export async function createBillingPortal(accessToken: string): Promise<{ portal_url: string }> {
  const value = await apiFetch<unknown>("/account/billing/portal", accessToken, {
    method: "POST",
  });
  if (!isRecord(value)) {
    throw invalidResponse("Billing portal");
  }
  return { portal_url: requiredUrl(value.portal_url, "Billing portal URL") };
}

export async function logout(accessToken: string): Promise<{ status: "logged_out" }> {
  const value = await apiFetch<unknown>("/account/logout", accessToken, { method: "POST" });
  if (!isRecord(value) || value.status !== "logged_out") {
    throw invalidResponse("Logout");
  }
  return { status: "logged_out" };
}

export async function deleteAccount(accessToken: string): Promise<{ status: "deleted" }> {
  const value = await apiFetch<unknown>("/account", accessToken, { method: "DELETE" });
  if (!isRecord(value) || value.status !== "deleted") {
    throw invalidResponse("Account deletion");
  }
  return { status: "deleted" };
}
