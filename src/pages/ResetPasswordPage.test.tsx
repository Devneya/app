import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, User } from "@supabase/supabase-js";
import { AppProviders } from "@/App";
import * as account from "@/api/account";
import { ResetPasswordPage } from "@/pages/ResetPasswordPage";
import { supabase } from "@/supabase";

const testUser = { id: "recovery-user", email: "recovery@example.com" } as unknown as User;
const testSession = { access_token: "recovery-token", user: testUser } as unknown as Session;

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProviders>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ResetPasswordPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AppProviders>
  );
}

describe("ResetPasswordPage", () => {
  beforeEach(() => {
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: testSession },
      error: null,
    });
    vi.spyOn(supabase.auth, "onAuthStateChange").mockImplementation((callback) => {
      queueMicrotask(() => callback("PASSWORD_RECOVERY", testSession));
      return {
        data: {
          subscription: { id: "reset-test", callback: vi.fn(), unsubscribe: vi.fn() },
        },
      };
    });
    vi.spyOn(supabase.auth, "updateUser").mockResolvedValue({
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
    expect(supabase.auth.updateUser).toHaveBeenCalledOnce();
    expect(account.logout).toHaveBeenCalledOnce();
  });
});
