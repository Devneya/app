import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, User } from "@supabase/supabase-js";
import { AuthProvider, useAuthContext } from "@/auth/AuthProvider";
import { supabase } from "@/supabase";

const testUser = {
  id: "user-id",
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
  phone: "",
  confirmed_at: "2026-01-01T00:00:00.000Z",
  last_sign_in_at: "2026-01-01T00:00:00.000Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
} as unknown as User;

const testSession = {
  access_token: "access-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1_800_000_000,
  refresh_token: "refresh-token",
  user: testUser,
} as unknown as Session;

async function renderAuth(initialSession: Session | null = null) {
  const sessionResponse = initialSession
    ? { data: { session: initialSession }, error: null }
    : { data: { session: null }, error: null };
  vi.spyOn(supabase.auth, "getSession").mockResolvedValue(
    sessionResponse as Awaited<ReturnType<typeof supabase.auth.getSession>>
  );
  vi.spyOn(supabase.auth, "onAuthStateChange").mockReturnValue({
    data: {
      subscription: { id: "test-subscription", callback: vi.fn(), unsubscribe: vi.fn() },
    },
  });

  const rendered = renderHook(() => useAuthContext(), {
    wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
  });
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthProvider response validation", () => {
  it("sends signup confirmation to this app's confirmation page", async () => {
    const data = { user: testUser, session: null };
    const signUp = vi.spyOn(supabase.auth, "signUp").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth();

    await expect(result.current.signUp("user@example.com", "password123")).resolves.toEqual({
      needsEmailConfirmation: true,
    });
    expect(signUp).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "password123",
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
  });

  it("keeps a recovery event received before initial session lookup completes", async () => {
    let finishSessionLookup!: (value: Awaited<ReturnType<typeof supabase.auth.getSession>>) => void;
    vi.spyOn(supabase.auth, "getSession").mockReturnValue(
      new Promise((resolve) => {
        finishSessionLookup = resolve;
      })
    );
    vi.spyOn(supabase.auth, "onAuthStateChange").mockImplementation((callback) => {
      queueMicrotask(() => callback("PASSWORD_RECOVERY", testSession));
      return {
        data: {
          subscription: { id: "recovery-test", callback: vi.fn(), unsubscribe: vi.fn() },
        },
      };
    });

    const rendered = renderHook(() => useAuthContext(), {
      wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
    });
    await waitFor(() => expect(rendered.result.current.passwordRecoveryPending).toBe(true));

    await act(async () => {
      finishSessionLookup({ data: { session: null }, error: null });
    });
    expect(rendered.result.current.passwordRecoveryPending).toBe(true);
    expect(rendered.result.current.session).toBe(testSession);
  });

  it("keeps session lookup errors after the initial auth event", async () => {
    const lookupError = new Error("Session lookup failed");
    vi.spyOn(supabase.auth, "getSession").mockRejectedValueOnce(lookupError);
    vi.spyOn(supabase.auth, "onAuthStateChange").mockImplementation((callback) => {
      queueMicrotask(() => callback("INITIAL_SESSION", null));
      return {
        data: {
          subscription: { id: "initial-session-test", callback: vi.fn(), unsubscribe: vi.fn() },
        },
      };
    });

    const rendered = renderHook(() => useAuthContext(), {
      wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
    });
    await waitFor(() => expect(rendered.result.current.initializationError).toBe(lookupError));
  });

  it("does not require confirmation when signup returns a session", async () => {
    const data = { user: testUser, session: testSession };
    const signUp = vi.spyOn(supabase.auth, "signUp").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth();

    await expect(result.current.signUp("user@example.com", "password123")).resolves.toEqual({
      needsEmailConfirmation: false,
    });
    expect(signUp).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "password123",
      options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
  });

  it("sends email-change confirmation to this app's confirmation page", async () => {
    const updateUser = vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
      data: { user: testUser } as never,
      error: null,
    });
    const { result } = await renderAuth(testSession);

    await expect(result.current.updateEmail("  next@example.com  ")).resolves.toBeUndefined();
    expect(updateUser).toHaveBeenCalledWith(
      { email: "next@example.com" },
      { emailRedirectTo: `${window.location.origin}/auth/confirm` }
    );
  });

  it("propagates email-change provider errors", async () => {
    const providerError = new Error("provider failure");
    vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
      data: { user: null } as never,
      error: providerError as never,
    });
    const { result } = await renderAuth(testSession);

    await expect(result.current.updateEmail("next@example.com")).rejects.toBe(providerError);
  });

  it("preserves the update response when no user is returned", async () => {
    const data = { user: null, marker: "update-response" };
    vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth();

    await expect(result.current.updatePassword("next-password")).rejects.toMatchObject({
      message: "Password update did not return a user.",
      cause: data,
    });
  });

  it("preserves the sign-in response when no session is returned", async () => {
    const data = { user: null, session: null, marker: "sign-in-response" };
    vi.spyOn(supabase.auth, "signInWithPassword").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth();

    await expect(result.current.signIn("user@example.com", "password")).rejects.toMatchObject({
      message: "Sign-in did not return a session.",
      cause: data,
    });
  });

  it("preserves the provider response when no redirect URL is returned", async () => {
    const data = { provider: "google", url: null, marker: "oauth-response" };
    vi.spyOn(supabase.auth, "signInWithOAuth").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth();

    await expect(result.current.signInWithProvider("google")).rejects.toMatchObject({
      message: "Provider sign-in did not return a redirect URL.",
      cause: data,
    });
  });

  it("preserves the reauthentication response when no session is returned", async () => {
    const data = { user: testUser, session: null, marker: "reauth-response" };
    vi.spyOn(supabase.auth, "signInWithPassword").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth(testSession);

    await expect(result.current.changePassword("current-password", "next-password")).rejects.toMatchObject({
      message: "Reauthentication did not return a session",
      cause: data,
    });
  });

  it("preserves the returned user when the saved display name does not match", async () => {
    const returnedUser = { ...testUser, user_metadata: { name: "different-name" } } as User;
    const data = { user: returnedUser, marker: "name-update-response" };
    vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
      data: data as never,
      error: null,
    });
    const { result } = await renderAuth();

    await expect(result.current.updateDisplayName("requested-name")).rejects.toMatchObject({
      message: "Profile update did not return the saved name.",
      cause: returnedUser,
    });
  });
});
