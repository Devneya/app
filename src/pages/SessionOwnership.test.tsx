import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { renderApp } from "@/test/render";
import { MOCK_USER, mockGoTrueAuthResponse } from "@/mocks/data";
import { server } from "@/mocks/server";
import { supabase } from "@/supabase";
import * as supabaseModule from "@/supabase";
import { config } from "@/config";
import { queryClient } from "@/App";

async function authenticatedPage(route: string) {
  const session = mockGoTrueAuthResponse(MOCK_USER.email) as Session;
  let authEvent!: Parameters<typeof supabase.auth.onAuthStateChange>[0];
  vi.spyOn(supabase.auth, "getSession").mockResolvedValue({ data: { session }, error: null });
  vi.spyOn(supabase.auth, "onAuthStateChange").mockImplementation(callback => {
    authEvent = callback;
    return { data: { subscription: { id: "audit", callback: vi.fn(), unsubscribe: vi.fn() } } };
  });
  vi.spyOn(supabase.auth, "signOut")
    .mockRejectedValueOnce(new Error("audit browser cleanup unavailable"))
    .mockResolvedValue({ error: null });
  renderApp(route);
  await screen.findByRole("button", { name: `Account menu: ${MOCK_USER.email}` });
  const emit = (event: Parameters<typeof authEvent>[0], next: Parameters<typeof authEvent>[1]) => {
    const key = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
    if (next) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
    return authEvent(event, next);
  };
  return { session, user: userEvent.setup(), authEvent: emit, rawAuthEvent: authEvent };
}

describe("Audit action completion belongs to its authenticated session", () => {
  it("performs global logout for a fresh session after the prior session's cleanup failed", async () => {
    const logouts: string[] = [];
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, ({ request }) => {
      logouts.push(request.headers.get("authorization") ?? "");
      return HttpResponse.json({ status: "logged_out" });
    }));
    const { session, user, authEvent } = await authenticatedPage("/");
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await screen.findByText(/Logout completed, but browser cleanup failed/);
    expect(logouts).toHaveLength(1);
    act(() => { authEvent("SIGNED_IN", { ...session, access_token: "audit-new-token", refresh_token: "audit-new-refresh" }); });
    await waitFor(() => expect(screen.queryByText(/Logout completed, but browser cleanup failed/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(2));
    expect(logouts).toEqual([`Bearer ${session.access_token}`, "Bearer audit-new-token"]);
  });

  it("offers deletion for a new account after the previous account deletion cleanup failed", async () => {
    const deletions: string[] = [];
    server.use(http.delete(`${config.apiBaseUrl}/account`, ({ request }) => {
      deletions.push(request.headers.get("authorization") ?? "");
      return HttpResponse.json({ status: "deleted" });
    }));
    const { session, user, authEvent } = await authenticatedPage("/account");
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByLabelText(/Account email/i), MOCK_USER.email);
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByText(/Account deletion completed, but browser cleanup failed/);
    expect(deletions).toHaveLength(1);
    const nextEmail = "new-account@example.test";
    act(() => { authEvent("SIGNED_IN", { ...session, access_token: "audit-new-token", refresh_token: "audit-new-refresh", user: { ...session.user, id: "audit-new-user", email: nextEmail } }); });
    await screen.findByRole("button", { name: `Account menu: ${nextEmail}` });
    expect(screen.queryByText(/Account deletion completed, but browser cleanup failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Account deletion completed, but local sign-out failed/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete account" })).toBeInTheDocument();
  });
  it("preserves completion across token refresh and retries only browser cleanup", async () => {
    let logouts = 0;
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => {
      logouts++;
      return HttpResponse.json({ status: "logged_out" });
    }));
    const { session, user, authEvent } = await authenticatedPage("/");
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await screen.findByText(/Logout completed, but browser cleanup failed/);
    act(() => { authEvent("TOKEN_REFRESHED", { ...session, access_token: "refreshed", refresh_token: "refreshed-token" }); });
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(2));
    expect(logouts).toBe(1);
  });

  it("does not clean up a new session when an earlier logout completes late", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, async () => {
      await pending;
      return HttpResponse.json({ status: "logged_out" });
    }));
    const { session, user, authEvent } = await authenticatedPage("/");
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    act(() => { authEvent("SIGNED_IN", { ...session, access_token: "new-token", refresh_token: "new-refresh" }); });
    await act(async () => { finish(); await pending; });
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Log out" })).toBeEnabled());
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("does not navigate a new session when earlier browser cleanup finishes late", async () => {
    let finish!: (value: { error: null }) => void;
    vi.spyOn(supabase.auth, "signOut").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { session, user, authEvent } = await authenticatedPage("/");
    vi.mocked(supabase.auth.signOut).mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledOnce());
    act(() => { authEvent("SIGNED_IN", { ...session, refresh_token: "new-refresh" }); });
    queryClient.setQueryData(["new-session"], "preserved");
    await act(async () => { finish({ error: null }); });
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Log out" })).toBeEnabled());
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(queryClient.getQueryData(["new-session"])).toBe("preserved");
  });

  it("does not clean up a new account when deletion finishes late", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    server.use(http.delete(`${config.apiBaseUrl}/account`, async () => {
      await pending;
      return HttpResponse.json({ status: "deleted" });
    }));
    const { session, user, authEvent } = await authenticatedPage("/account");
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByLabelText(/Account email/i), MOCK_USER.email);
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    act(() => { authEvent("SIGNED_IN", { ...session, refresh_token: "new-refresh" }); });
    await act(async () => { finish(); await pending; });
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.type(screen.getByLabelText(/Account email/i), MOCK_USER.email);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm delete" })).toBeEnabled());
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("transfers password change to reauthentication and ignores its late result after another login", async () => {
    let logouts = 0;
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => { logouts++; return HttpResponse.json({ status: "logged_out" }); }));
    const { session, user, authEvent } = await authenticatedPage("/account");
    const reauthenticated = { ...session, access_token: "reauth-token", refresh_token: "reauth-refresh" };
    const passwordClient = supabaseModule.createPasswordClient();
    vi.spyOn(supabaseModule, "createPasswordClient").mockReturnValue(passwordClient);
    vi.spyOn(passwordClient.auth, "signInWithPassword").mockImplementation(async () => {
      return { data: { user: reauthenticated.user, session: reauthenticated }, error: null };
    });
    let finish!: (result: Awaited<ReturnType<typeof supabase.auth.updateUser>>) => void;
    vi.spyOn(passwordClient.auth, "updateUser").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText(/Current password/i), "old-password");
    await user.type(screen.getByLabelText(/^New password/i), "new-password");
    await user.type(screen.getByLabelText(/Confirm new password/i), "new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    await waitFor(() => expect(passwordClient.auth.updateUser).toHaveBeenCalledOnce());
    act(() => { authEvent("SIGNED_IN", { ...session, refresh_token: "later-refresh" }); });
    await act(async () => { finish({ data: { user: session.user }, error: null }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save new password" })).toBeEnabled());
    expect(logouts).toBe(0);
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("uses the reauthenticated session for password change cleanup", async () => {
    const tokens: string[] = [];
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, ({ request }) => {
      tokens.push(request.headers.get("authorization") ?? "");
      return HttpResponse.json({ status: "logged_out" });
    }));
    const { session, user } = await authenticatedPage("/account");
    const reauthenticated = { ...session, access_token: "reauth-token", refresh_token: "reauth-refresh" };
    const passwordClient = supabaseModule.createPasswordClient();
    vi.spyOn(supabaseModule, "createPasswordClient").mockReturnValue(passwordClient);
    vi.spyOn(passwordClient.auth, "signInWithPassword").mockImplementation(async () => {
      return { data: { user: reauthenticated.user, session: reauthenticated }, error: null };
    });
    vi.spyOn(passwordClient.auth, "updateUser").mockResolvedValue({ data: { user: session.user }, error: null });
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText(/Current password/i), "old-password");
    await user.type(screen.getByLabelText(/^New password/i), "new-password");
    await user.type(screen.getByLabelText(/Confirm new password/i), "new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    await screen.findByText(/Password change completed, but browser cleanup failed/);
    expect(tokens).toEqual(["Bearer reauth-token"]);
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(2));
    expect(tokens).toHaveLength(1);
  });

  it("shows a failed password update after reauthentication and allows retry", async () => {
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => HttpResponse.json({ status: "logged_out" })));
    const { session, user } = await authenticatedPage("/account");
    let attempts = 0;
    const passwordClient = supabaseModule.createPasswordClient();
    vi.spyOn(supabaseModule, "createPasswordClient").mockReturnValue(passwordClient);
    vi.spyOn(passwordClient.auth, "signInWithPassword").mockImplementation(async () => {
      const reauthenticated = { ...session, access_token: `reauth-token-${++attempts}`, refresh_token: `reauth-refresh-${attempts}` };
      return { data: { user: reauthenticated.user, session: reauthenticated }, error: null };
    });
    const update = vi.spyOn(passwordClient.auth, "updateUser")
      .mockRejectedValueOnce(new Error("password update unavailable"))
      .mockResolvedValue({ data: { user: session.user }, error: null });
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText(/Current password/i), "old-password");
    await user.type(screen.getByLabelText(/^New password/i), "new-password");
    await user.type(screen.getByLabelText(/Confirm new password/i), "new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText(/password update unavailable/)).toBeInTheDocument();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Current password/i), "old-password");
    await user.type(screen.getByLabelText(/^New password/i), "new-password");
    await user.type(screen.getByLabelText(/Confirm new password/i), "new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    await screen.findByText(/Password change completed, but browser cleanup failed/);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(["same account", "different account"])("keeps a newer %s session when delayed isolated reauthentication saves and emits its session", async (account) => {
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const requestSeen = new Promise<void>(resolve => { requested = resolve; });
    server.use(http.post(`${config.apiBaseUrl}/auth/token`, async () => {
      requested();
      await pending;
      return HttpResponse.json(mockGoTrueAuthResponse(MOCK_USER.email));
    }));
    const { session, user, authEvent } = await authenticatedPage("/account");
    const passwordClient = supabaseModule.createPasswordClient();
    vi.spyOn(supabaseModule, "createPasswordClient").mockReturnValue(passwordClient);
    const events: string[] = [];
    passwordClient.auth.onAuthStateChange(event => { events.push(event); });
    const update = vi.spyOn(passwordClient.auth, "updateUser");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText(/Current password/i), "old-password");
    await user.type(screen.getByLabelText(/^New password/i), "new-password");
    await user.type(screen.getByLabelText(/Confirm new password/i), "new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    await requestSeen;
    const nextEmail = account === "same account" ? MOCK_USER.email : "other@example.test";
    const nextId = account === "same account" ? session.user.id : "other";
    act(() => { authEvent("SIGNED_IN", { ...session, refresh_token: "new-refresh", user: { ...session.user, id: nextId, email: nextEmail } }); });
    const sharedStorage = JSON.stringify(localStorage);
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save new password" })).toBeEnabled());
    expect(events).toContain("SIGNED_IN");
    expect(JSON.stringify(localStorage)).toBe(sharedStorage);
    expect(screen.getByRole("button", { name: `Account menu: ${nextEmail}` })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("ignores stale SDK events when the newer session is already persisted", async () => {
    const { session, authEvent, rawAuthEvent } = await authenticatedPage("/account");
    const nextEmail = "other@example.test";
    const next = { ...session, refresh_token: "new-refresh", user: { ...session.user, id: "other", email: nextEmail } };
    const key = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
    localStorage.setItem(key, JSON.stringify(next));
    act(() => { authEvent("SIGNED_IN", next); });
    await screen.findByRole("button", { name: `Account menu: ${nextEmail}` });
    act(() => { rawAuthEvent("USER_UPDATED", session); rawAuthEvent("SIGNED_OUT", null); });
    expect(screen.getByRole("button", { name: `Account menu: ${nextEmail}` })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(next);
  });

  it("does not start backend logout when newer storage precedes its auth event", async () => {
    let logouts = 0;
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => { logouts++; return HttpResponse.json({ status: "logged_out" }); }));
    const { session, user } = await authenticatedPage("/");
    const key = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
    localStorage.setItem(key, JSON.stringify({ ...session, refresh_token: "new-refresh" }));
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Log out" })).toBeEnabled());
    expect(logouts).toBe(0);
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

  it("offers cleanup-only retry after a refresh saved before its event", async () => {
    let logouts = 0;
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => { logouts++; return HttpResponse.json({ status: "logged_out" }); }));
    const { session, user, rawAuthEvent } = await authenticatedPage("/");
    const key = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
    localStorage.setItem(key, JSON.stringify(session));
    let finish!: (value: { error: null }) => void;
    vi.mocked(supabase.auth.signOut).mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ error: null });
    await user.click(screen.getByRole("button", { name: `Account menu: ${MOCK_USER.email}` }));
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledOnce());
    const refreshed = { ...session, access_token: "refreshed-token", refresh_token: "refreshed-refresh" };
    localStorage.setItem(key, JSON.stringify(refreshed));
    await act(async () => { finish({ error: null }); });
    expect(screen.queryByText(/Logout completed, but browser cleanup failed/)).not.toBeInTheDocument();
    act(() => { rawAuthEvent("TOKEN_REFRESHED", refreshed); });
    await screen.findByText(/Logout completed, but browser cleanup failed/);
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(2));
    expect(logouts).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

});
