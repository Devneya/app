import type {
  CancelSubscriptionResponse,
  KeyResponse,
  SubscribeResponse,
  SubscriptionStatus,
  UsageResponse,
} from "@/api/types";
import { readApiResponse } from "@/api/errors";
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

class InvalidResponseError extends Error {
  readonly responseBody: unknown;

  constructor(name: string, responseBody: unknown, cause: unknown) {
    super(`${name} response was invalid.`, { cause });
    this.name = "InvalidResponseError";
    this.responseBody = responseBody;
  }
}

function invalidResponse(name: string, responseBody?: unknown, cause = responseBody): Error {
  return new InvalidResponseError(name, responseBody, cause);
}

function requiredString(value: unknown, name: string, responseBody = value): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse(name, responseBody);
  }
  return value;
}

function requiredUrl(value: unknown, name: string, responseBody = value): string {
  const url = requiredString(value, name, responseBody).trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported URL scheme");
    }
  } catch (cause) {
    throw invalidResponse(name, responseBody, cause);
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
    throw invalidResponse("Subscription cancellation", value);
  }
  return {
    ...value,
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
  return (await readApiResponse(resp)) as T;
}

export function fetchVirtualKey(accessToken: string): Promise<KeyResponse> {
  return apiFetch<unknown>("/account/key", accessToken).then((value) => {
    if (!isRecord(value)) {
      throw invalidResponse("API key", value);
    }
    return { ...value, key: requiredString(value.key, "API key", value) } as KeyResponse;
  });
}

export async function fetchUsage(accessToken: string): Promise<UsageResponse> {
  const value = await apiFetch<unknown>("/account/usage", accessToken);
  if (!isRecord(value)) {
    throw invalidResponse("Usage", value);
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
    throw invalidResponse("Usage", value);
  }
  return value as UsageResponse;
}

export async function startSubscription(accessToken: string): Promise<SubscribeResponse> {
  const value = await apiFetch<unknown>("/account/subscribe", accessToken, {
    method: "POST",
  });
  if (!isRecord(value) || value.status !== "checkout") {
    throw invalidResponse("Subscription", value);
  }
  return {
    ...value,
    status: "checkout",
    checkout_url: requiredUrl(value.checkout_url, "Subscription checkout URL", value),
    expires_at: requiredString(value.expires_at, "Subscription checkout expiry", value),
  } as SubscribeResponse;
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
    throw invalidResponse("Billing portal", value);
  }
  return {
    ...value,
    portal_url: requiredUrl(value.portal_url, "Billing portal URL", value),
  } as { portal_url: string };
}

export async function logout(accessToken: string): Promise<{ status: "logged_out" }> {
  const value = await apiFetch<unknown>("/account/logout", accessToken, { method: "POST" });
  if (!isRecord(value) || value.status !== "logged_out") {
    throw invalidResponse("Logout", value);
  }
  return { ...value, status: "logged_out" } as { status: "logged_out" };
}

export async function deleteAccount(accessToken: string): Promise<{ status: "deleted" }> {
  const value = await apiFetch<unknown>("/account", accessToken, { method: "DELETE" });
  if (!isRecord(value) || value.status !== "deleted") {
    throw invalidResponse("Account deletion", value);
  }
  return { ...value, status: "deleted" } as { status: "deleted" };
}
