import type {
  CancelSubscriptionResponse,
  KeyResponse,
  SubscribeResponse,
  UsageResponse,
} from "@/api/types";
import { throwApiRequestError } from "@/api/errors";
import { config } from "@/config";

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
  return apiFetch<KeyResponse>("/account/key", accessToken);
}

export function fetchUsage(accessToken: string): Promise<UsageResponse> {
  return apiFetch<UsageResponse>("/account/usage", accessToken);
}

export function startSubscription(
  accessToken: string
): Promise<SubscribeResponse> {
  return apiFetch<SubscribeResponse>("/account/subscribe", accessToken, {
    method: "POST",
  });
}

export function cancelSubscription(
  accessToken: string
): Promise<CancelSubscriptionResponse> {
  return apiFetch<CancelSubscriptionResponse>("/account/subscribe/cancel", accessToken, {
    method: "POST",
  });
}

export function uncancelSubscription(
  accessToken: string
): Promise<CancelSubscriptionResponse> {
  return apiFetch<CancelSubscriptionResponse>("/account/subscribe/uncancel", accessToken, {
    method: "POST",
  });
}

export function createBillingPortal(accessToken: string): Promise<{ portal_url: string }> {
  return apiFetch("/account/billing/portal", accessToken, { method: "POST" });
}

export function logout(accessToken: string): Promise<{ status: string }> {
  return apiFetch("/account/logout", accessToken, { method: "POST" });
}

export function deleteAccount(accessToken: string): Promise<{ status: string }> {
  return apiFetch("/account", accessToken, { method: "DELETE" });
}
