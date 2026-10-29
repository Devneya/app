import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, User } from "@supabase/supabase-js";
import { AppProviders } from "@/App";
import * as account from "@/api/account";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { supabase } from "@/supabase";
import * as supabaseModule from "@/supabase";
import { config } from "@/config";

const testUser = { id: "recovery-user", email: "recovery@example.com" } as unknown as User;
const testSession = { access_token: "recovery-token", refresh_token: "recovery-refresh", user: testUser } as unknown as Session;

function persistTestSession(session: Session) {
  localStorage.setItem(`sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`, JSON.stringify(session));
}

function renderPage() {
  return render(
    <AppProviders>
      <MemoryRouter>
        <ResetPasswordPage />
      </MemoryRouter>
    </AppProviders>
  );
}

describe("ResetPasswordPage", () => {
  let recoveryClient: ReturnType<typeof supabaseModule.createRecoveryClient>;
  beforeEach(() => {
    vi.spyOn(supabase.auth, "initialize").mockResolvedValue({ error: null });
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: testSession },
      error: null,
    });
    vi.spyOn(supabase.auth, "onAuthStateChange").mockImplementation((callback) => {
      queueMicrotask(() => { persistTestSession(testSession); callback("PASSWORD_RECOVERY", testSession); });
      return {
        data: {
          subscription: { id: "reset-test", callback: vi.fn(), unsubscribe: vi.fn() },
        },
      };
    });
    recoveryClient = { auth: { updateUser: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) } } as unknown as ReturnType<typeof supabaseModule.createRecoveryClient>;
    vi.spyOn(supabaseModule, "createRecoveryClient").mockReturnValue(recoveryClient);
    vi.spyOn(recoveryClient.auth, "updateUser").mockResolvedValue({
      data: { user: testUser },
      error: null,
    });
    vi.spyOn(supabase.auth, "signOut").mockResolvedValue({ error: null });
    vi.spyOn(account, "logout").mockRejectedValue(new Error("backend logout unavailable"));
  });

  it("keeps the password-change completion message when backend logout fails", async () => {
    renderPage();
    const user = userEvent.setup();

    const passwordFields = await screen.findAllByLabelText(/password/i);
    await user.type(passwordFields[0], "new-password");
    await user.type(passwordFields[1], "new-password");
    await user.click(screen.getByRole("button", { name: "Save password" }));

    expect(
      await screen.findByText(
        "Password changed, but backend logout failed: backend logout unavailable"
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish password change" })).toBeInTheDocument();
    expect(recoveryClient.auth.updateUser).toHaveBeenCalledOnce();
    expect(account.logout).toHaveBeenCalledOnce();
  });
  it("reports recovery completion and retries only browser cleanup", async () => {
    vi.mocked(account.logout).mockResolvedValue({ status: "logged_out" });
    vi.mocked(supabase.auth.signOut).mockRejectedValueOnce(new Error("cleanup unavailable"));
    renderPage();
    const user = userEvent.setup();
    const fields = await screen.findAllByLabelText(/password/i);
    await user.type(fields[0], "new-password");
    await user.type(fields[1], "new-password");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText(/Password recovery completed, but browser cleanup failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    expect(account.logout).toHaveBeenCalledOnce();
    expect(recoveryClient.auth.updateUser).toHaveBeenCalledOnce();
  });

  it("does not log out a new session when recovery finishes late", async () => {
    let event!: Parameters<typeof supabase.auth.onAuthStateChange>[0];
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation(callback => {
      event = callback;
      queueMicrotask(() => { persistTestSession(testSession); callback("PASSWORD_RECOVERY", testSession); });
      return { data: { subscription: { id: "reset-test", callback: vi.fn(), unsubscribe: vi.fn() } } };
    });
    let finish!: (result: Awaited<ReturnType<typeof supabase.auth.updateUser>>) => void;
    vi.mocked(recoveryClient.auth.updateUser).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPage();
    const user = userEvent.setup();
    const fields = await screen.findAllByLabelText(/password/i);
    await user.type(fields[0], "new-password");
    await user.type(fields[1], "new-password");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(recoveryClient.auth.updateUser).toHaveBeenCalledOnce());
    act(() => { const next = { ...testSession, refresh_token: "new-refresh" }; persistTestSession(next); event("SIGNED_IN", next); });
    await act(async () => { finish({ data: { user: testUser }, error: null }); });
    expect(account.logout).not.toHaveBeenCalled();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
    expect(screen.getByText(/Open the reset link/)).toBeInTheDocument();
  });

  it("does not start backend logout if a new session was saved before its event", async () => {
    let finish!: (result: Awaited<ReturnType<typeof supabase.auth.updateUser>>) => void;
    vi.mocked(recoveryClient.auth.updateUser).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPage();
    const user = userEvent.setup();
    const fields = await screen.findAllByLabelText(/password/i);
    await user.type(fields[0], "new-password");
    await user.type(fields[1], "new-password");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(recoveryClient.auth.updateUser).toHaveBeenCalledOnce());
    persistTestSession({ ...testSession, refresh_token: "new-refresh" });
    await act(async () => { finish({ data: { user: testUser }, error: null }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save password" })).toBeEnabled());
    expect(account.logout).not.toHaveBeenCalled();
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });

});
