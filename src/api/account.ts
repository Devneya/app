import type {
  KeyResponse,
  SubscribeResponse,
  UsageResponse,
} from "@/api/types";
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
    const body = await resp.text();
    throw new Error(`${path} failed (${resp.status}): ${body}`);
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
): Promise<{ status: string; access_until?: string }> {
  return apiFetch("/account/subscribe/cancel", accessToken, { method: "POST" });
}

export function logout(accessToken: string): Promise<{ status: string }> {
  return apiFetch("/account/logout", accessToken, { method: "POST" });
}

export function deleteAccount(accessToken: string): Promise<{ status: string }> {
  return apiFetch("/account", accessToken, { method: "DELETE" });
}
