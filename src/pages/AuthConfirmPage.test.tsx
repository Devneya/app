import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { AuthProvider } from "@/auth/AuthProvider";
import { AuthConfirmPage } from "@/pages/AuthConfirmPage";
import { supabase } from "@/supabase";

function HistoryBack() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Back history</button>;
}

function mockAuthSubscription() {
  vi.spyOn(supabase.auth, "onAuthStateChange").mockReturnValue({
    data: {
      subscription: { id: "test-subscription", callback: vi.fn(), unsubscribe: vi.fn() },
    },
  });
}

function mockAuthSession(session: Session | null) {
  vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
    data: { session },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
  mockAuthSubscription();
}

function page() {
  return (
    <AuthProvider>
      <MemoryRouter initialEntries={["/previous", "/auth/confirm"]} initialIndex={1}>
        <Routes>
          <Route path="/previous" element={<h1>Previous page</h1>} />
          <Route path="/auth/confirm" element={<AuthConfirmPage />} />
          <Route path="/" element={<><h1>Home</h1><HistoryBack /></>} />
          <Route path="/login" element={<h1>Sign in</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

afterEach(() => {
  window.location.hash = "";
  vi.useRealTimers();
});

describe("AuthConfirmPage", () => {
  it("waits for session loading instead of showing the no-session result", async () => {
    vi.useFakeTimers();
    let resolveSession!: (
      value: Awaited<ReturnType<typeof supabase.auth.getSession>>
    ) => void;
    const pendingSession = new Promise<
      Awaited<ReturnType<typeof supabase.auth.getSession>>
    >((resolve) => {
      resolveSession = resolve;
    });
    vi.spyOn(supabase.auth, "getSession").mockReturnValue(pendingSession);
    mockAuthSubscription();
    render(page());

    expect(screen.getByRole("heading", { name: "Confirming…" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("heading", { name: "Almost there" })).not.toBeInTheDocument();
    await act(async () => {
      resolveSession({ data: { session: null }, error: null });
    });
  });

  it("replaces the confirmation history entry after a success hash creates a session", async () => {
    const authSession = { access_token: "test-token" } as Session;
    window.location.hash = "#access_token=confirmation-token&refresh_token=refresh-token";
    mockAuthSession(authSession);
    render(page());

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back history" }));
    expect(await screen.findByRole("heading", { name: "Previous page" })).toBeInTheDocument();
  });

  it("shows a decoded error description and does not navigate with a session", () => {
    mockAuthSession({ access_token: "test-token" } as Session);
    window.location.hash = "#error=access_denied&error_description=Expired+link%2Bdetails";
    render(page());

    expect(screen.getByRole("heading", { name: "Confirmation failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Expired link+details");
    expect(screen.queryByRole("heading", { name: "Home" })).not.toBeInTheDocument();
  });

  it("uses the error code when the confirmation link has no description", () => {
    mockAuthSession(null);
    window.location.hash = "#error=access_denied";
    render(page());

    expect(screen.getByRole("alert")).toHaveTextContent("access_denied");
  });

  it("offers sign-in after four seconds when no session is created", async () => {
    vi.useFakeTimers();
    mockAuthSession(null);
    render(page());
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Confirming…" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.queryByRole("heading", { name: "Almost there" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("heading", { name: "Almost there" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Back to sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
