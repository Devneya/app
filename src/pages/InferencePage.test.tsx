import * as supabaseModule from "@/supabase";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderApp } from "@/test/render";
import { MOCK_USER, MOCK_VIRTUAL_KEY } from "@/mocks/data";
import { setMockBillingState, setMockSubscribed } from "@/mocks/handlers";
import { config } from "@/config";
import { server } from "@/mocks/server";
import { supabase } from "@/supabase";
import { queryClient } from "@/App";
import { focusManager } from "@tanstack/react-query";

async function signInViaUi() {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: /email/i }), MOCK_USER.email);
  await user.type(screen.getByLabelText(/password/i), MOCK_USER.password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

async function openAccountMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", {
      name: new RegExp(`Account menu: ${MOCK_USER.email}`, "i"),
    })
  );
}

describe("InferencePage", () => {
  beforeEach(() => {
    setMockSubscribed(false);
  });

  it("explains that the virtual key follows verified payment", async () => {
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      expect(screen.getByText(/API key will appear after the first verified payment/i)).toBeInTheDocument();
      expect(screen.getByText(/Spent:/)).toHaveTextContent("Spent: €0.00 / €10.00");
      expect(screen.getByRole("link", { name: "LLM inference" })).toBeInTheDocument();
      expect(screen.getByText("[Devneya]")).toBeInTheDocument();
      expect(screen.queryByText(/\/ llm inference/i)).not.toBeInTheDocument();
    });
  });

  it("shows subscribe button when not subscribed", async () => {
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    });
  });

  it("shows usage when subscribed", async () => {
    setMockSubscribed(true);
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      expect(screen.getByText(/Status:/)).toHaveTextContent("active");
      expect(screen.getByText(MOCK_VIRTUAL_KEY)).toBeInTheDocument();
      expect(screen.getByText(/Spent:/)).toHaveTextContent("Spent: €0.42 / €10.00");
      expect(screen.getByRole("progressbar", { name: "Usage progress" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeInTheDocument();
    });
  });

  it.each([
    [0, "€0.00"],
    [0.000012, "€0.000012"],
    [0.00000001, "<€0.000001"],
  ])("displays usage %s without rounding positive spend to zero", async (used, formatted) => {
    server.use(
      http.get(`${config.apiBaseUrl}/account/usage`, () => HttpResponse.json({
        used,
        limit: 10,
        entitlement_status: "active",
        cancel_at_period_end: false,
        access_until: null,
        required_billing_action: "none",
      }))
    );
    renderApp("/login");
    await signInViaUi();
    await waitFor(() => {
      expect(screen.getByText(/Spent:/)).toHaveTextContent(`Spent: ${formatted} / €10.00`);
    });
  });

  it("schedules cancel at period end while staying active", async () => {
    setMockSubscribed(true);
    renderApp("/login");
    const user = await signInViaUi();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));

    await waitFor(() => {
      expect(screen.getByText(/Status:/)).toHaveTextContent("active");
      expect(screen.getByText(/Cancellation scheduled/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel subscription" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Keep subscription" })).toBeInTheDocument();
    });
  });

  it.each([
    ["past_due", "update_payment", "button", "Update payment method"],
    ["review_required", "contact_support", "alert", "Billing requires support review."],
    ["expired", "subscribe", "button", "Subscribe"],
  ] as const)("renders the %s billing state", async (status, action, role, label) => {
    setMockBillingState(status, action);
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      const element =
        role === "button" ? screen.getByRole("button", { name: label }) : screen.getByText(label);
      expect(element).toBeInTheDocument();
    });
  });

  it("opens profile from account menu", async () => {
    renderApp("/login");
    const user = await signInViaUi();

    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Profile" }));

    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LLM inference" })).toBeInTheDocument();
    expect(screen.queryByText(/\/ profile/i)).not.toBeInTheDocument();

    await openAccountMenu(user);
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("saves display name on account page", async () => {
    renderApp("/login");
    const user = await signInViaUi();

    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Profile" }));
    await user.clear(screen.getByLabelText(/^name$/i));
    await user.type(screen.getByLabelText(/^name$/i), "Demo User");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/profile saved/i);
      expect(
        screen.getByRole("button", { name: new RegExp(`Account menu: ${MOCK_USER.email}`, "i") })
      ).toHaveTextContent("Demo User");
    });
  });

  it("does not repeat backend logout after local sign-out fails", async () => {
    let logoutRequests = 0;
    server.use(
      http.post(`${config.apiBaseUrl}/account/logout`, () => {
        logoutRequests += 1;
        return HttpResponse.json({ status: "logged_out" });
      })
    );
    const realSignOut = supabase.auth.signOut.bind(supabase.auth);
    vi.spyOn(supabase.auth, "signOut")
      .mockRejectedValueOnce(new Error("Local sign-out unavailable"))
      .mockImplementation(() => realSignOut({ scope: "local" }));

    renderApp("/login");
    const user = await signInViaUi();
    queryClient.setQueryData(["cleanup-retry"], "retained");
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Logout completed, but browser cleanup failed"
      );
      expect(screen.getByRole("button", { name: "Retry browser cleanup" })).toBeInTheDocument();
    });
    expect(logoutRequests).toBe(1);
    expect(queryClient.getQueryData(["cleanup-retry"])).toBe("retained");

    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });
    expect(logoutRequests).toBe(1);
    expect(queryClient.getQueryData(["cleanup-retry"])).toBeUndefined();
  });
  it("refreshes usage and key after delayed activation", async () => {
    renderApp("/login");
    const user = await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    setMockSubscribed(true);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getByText(/Status:/)).toHaveTextContent("active");
      expect(screen.getByText(MOCK_VIRTUAL_KEY)).toBeInTheDocument();
    });
  });

  it("does not refetch account data after backend logout while browser cleanup is pending", async () => {
    vi.mocked(supabaseModule.createSessionClient).mockRestore();
    let revoked = false;
    const afterLogout: string[] = [];
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    server.use(
      http.post(`${config.apiBaseUrl}/account/logout`, () => { revoked = true; return HttpResponse.json({ status: "logged_out" }); }),
      http.post(`${config.apiBaseUrl}/auth/logout`, async () => { entered(); await pending; return new HttpResponse(null, { status: 204 }); }),
      http.get(`${config.apiBaseUrl}/account/key`, () => { if (revoked) { afterLogout.push("key"); return HttpResponse.json({}, { status: 401 }); } return HttpResponse.json({ key: null }); }),
      http.get(`${config.apiBaseUrl}/account/usage`, () => { if (revoked) { afterLogout.push("usage"); return HttpResponse.json({}, { status: 401 }); } return HttpResponse.json({ limit: 10, used: 0, entitlement_status: "none", cancel_at_period_end: false, required_billing_action: "subscribe", access_until: null }); })
    );
    renderApp("/login");
    const user = await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await started;
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      expect(afterLogout).toEqual([]);
      finish();
      await screen.findByRole("heading", { name: "Sign in" });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      expect(afterLogout).toEqual([]);
    } finally {
      finish();
    }
  });

  it("clears cached data after verified browser cleanup", async () => {
    let finish!: (value: { error: null }) => void;
    const signOut = vi.spyOn(supabase.auth, "signOut").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderApp("/login");
    const user = await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    queryClient.setQueryData(["cleanup-order"], "retained");
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(["cleanup-order"])).toBe("retained");
    await act(async () => { finish({ error: null }); });
    await waitFor(() => expect(queryClient.getQueryData(["cleanup-order"])).toBeUndefined());
  });

  it("preserves cached data when backend logout fails", async () => {
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => HttpResponse.json({ error: "unavailable" }, { status: 500 })));
    const signOut = vi.spyOn(supabase.auth, "signOut");
    renderApp("/login");
    const user = await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    queryClient.setQueryData(["backend-failure"], "retained");
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    await screen.findByText(/Could not log out/);
    expect(queryClient.getQueryData(["backend-failure"])).toBe("retained");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("keeps cleanup retry visible when the SDK removes the session and returns an error", async () => {
    const realSignOut = supabase.auth.signOut.bind(supabase.auth);
    vi.spyOn(supabase.auth, "signOut").mockImplementationOnce(async () => {
      await realSignOut({ scope: "local" });
      return { error: new Error("cleanup failed") as never };
    }).mockImplementation(() => realSignOut({ scope: "local" }));
    renderApp("/login");
    const user = await signInViaUi();
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(await screen.findByText(/Logout completed, but browser cleanup failed/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    await waitFor(() => expect(screen.queryByText(/Logout completed, but browser cleanup failed/)).not.toBeInTheDocument());
  });

  it("reports account deletion cleanup failure without repeating deletion", async () => {
    let deletions = 0;
    server.use(http.delete(`${config.apiBaseUrl}/account`, () => { deletions++; return HttpResponse.json({ status: "deleted" }); }));
    vi.spyOn(supabase.auth, "signOut").mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue({ error: null });
    renderApp("/login");
    const user = await signInViaUi();
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Profile" }));
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    await user.type(screen.getByLabelText(/Account email/i), MOCK_USER.email);
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByText(/Account deletion completed, but browser cleanup failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    expect(deletions).toBe(1);
  });

  it("reports password change cleanup failure without repeating the change or logout", async () => {
    let logouts = 0;
    server.use(http.post(`${config.apiBaseUrl}/account/logout`, () => { logouts++; return HttpResponse.json({ status: "logged_out" }); }));
    const passwordClient = supabaseModule.createPasswordClient();
    vi.spyOn(supabaseModule, "createPasswordClient").mockReturnValue(passwordClient);
    const update = vi.spyOn(passwordClient.auth, "updateUser");
    vi.spyOn(supabase.auth, "signOut").mockRejectedValueOnce(new Error("cleanup unavailable")).mockResolvedValue({ error: null });
    renderApp("/login");
    const user = await signInViaUi();
    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Profile" }));
    await user.click(await screen.findByRole("button", { name: "Change password" }));
    await user.type(screen.getByLabelText(/Current password/i), MOCK_USER.password);
    await user.type(screen.getByLabelText(/^New password/i), "new-password");
    await user.type(screen.getByLabelText(/Confirm new password/i), "new-password");
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByText(/Password change completed, but browser cleanup failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser cleanup" }));
    expect(logouts).toBe(1);
    expect(update).toHaveBeenCalledOnce();
  });

  it("refreshes usage and key on window focus after delayed activation", async () => {
    renderApp("/login");
    await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    focusManager.setFocused(false);
    setMockSubscribed(true);
    focusManager.setFocused(true);
    await waitFor(() => {
      expect(screen.getByText(/Status:/)).toHaveTextContent("active");
      expect(screen.getByText(MOCK_VIRTUAL_KEY)).toBeInTheDocument();
    });
    focusManager.setFocused(undefined);
  });

  it("keeps refresh available and shows a partial refresh failure", async () => {
    renderApp("/login");
    const user = await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    setMockSubscribed(true);
    server.use(http.get(`${config.apiBaseUrl}/account/usage`, () => HttpResponse.json({ error: { code: "failure", message: "Usage unavailable", request_id: "test" } }, { status: 500 })));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Usage unavailable/)).toBeInTheDocument();
    expect(await screen.findByText(MOCK_VIRTUAL_KEY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("keeps the latest billing action error when an older action finishes", async () => {
    let finishSubscribe!: () => void;
    const subscribeWait = new Promise<void>(resolve => { finishSubscribe = resolve; });
    server.use(
      http.post(`${config.apiBaseUrl}/account/subscribe`, async () => {
        await subscribeWait;
        return HttpResponse.json({ error: { code: "failure", message: "Older subscribe failure", request_id: "old" } }, { status: 500 });
      }),
      http.post(`${config.apiBaseUrl}/account/subscribe/cancel`, () => HttpResponse.json({ error: { code: "failure", message: "Current cancellation failure", request_id: "new" } }, { status: 500 }))
    );
    renderApp("/login");
    const user = await signInViaUi();
    await user.click(await screen.findByRole("button", { name: "Subscribe" }));
    setMockSubscribed(true);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(await screen.findByText(/Current cancellation failure/)).toBeInTheDocument();
    finishSubscribe();
    await waitFor(() => expect(queryClient.getMutationCache().getAll().some(mutation =>
      mutation.state.status === "error" &&
      mutation.state.error instanceof Error &&
      mutation.state.error.message.includes("Older subscribe failure")
    )).toBe(true));
    expect(screen.getByText(/Current cancellation failure/)).toBeInTheDocument();
    expect(screen.queryByText(/Older subscribe failure/)).not.toBeInTheDocument();
  });

  it("replaces a completed billing action error with the next action error", async () => {
    server.use(
      http.post(`${config.apiBaseUrl}/account/subscribe`, () => HttpResponse.json({ error: { code: "failure", message: "Subscribe failed first", request_id: "first" } }, { status: 500 })),
      http.post(`${config.apiBaseUrl}/account/subscribe/cancel`, () => HttpResponse.json({ error: { code: "failure", message: "Cancellation failed next", request_id: "next" } }, { status: 500 }))
    );
    renderApp("/login");
    const user = await signInViaUi();
    await user.click(await screen.findByRole("button", { name: "Subscribe" }));
    await screen.findByText(/Subscribe failed first/);
    setMockSubscribed(true);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(await screen.findByText(/Cancellation failed next/)).toBeInTheDocument();
    expect(screen.queryByText(/Subscribe failed first/)).not.toBeInTheDocument();
  });

  it("shows key refresh failure while usage refresh succeeds", async () => {
    renderApp("/login");
    const user = await signInViaUi();
    await screen.findByRole("button", { name: "Subscribe" });
    setMockSubscribed(true);
    server.use(http.get(`${config.apiBaseUrl}/account/key`, () => HttpResponse.json({ error: { code: "failure", message: "Key unavailable", request_id: "test" } }, { status: 500 })));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Key unavailable/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Status:/)).toHaveTextContent("active"));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

});
