import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_USER } from "@/mocks/data";
import { supabase } from "@/supabase";

describe("LoginPage", () => {
  it("renders sign-in form", () => {
    renderApp("/login");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /email/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /forgot password/i })).toBeInTheDocument();
  });

  it("shows error on invalid credentials", async () => {
    renderApp("/login");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: /email/i }), "wrong@example.com");
    await user.type(screen.getByLabelText(/password/i), "badpass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("renders a fallback when authentication rejects with a falsy cause", async () => {
    vi.spyOn(supabase.auth, "signInWithPassword").mockRejectedValueOnce(null as never);
    renderApp("/login");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: /email/i }), "wrong@example.com");
    await user.type(screen.getByLabelText(/password/i), "badpass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Authentication failed");
    });
  });

  it("signs in with mock credentials", async () => {
    renderApp("/login");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: /email/i }), MOCK_USER.email);
    await user.type(screen.getByLabelText(/password/i), MOCK_USER.password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "LLM inference" })).toBeInTheDocument();
      expect(screen.getByText(MOCK_USER.email)).toBeInTheDocument();
    });
  });

  it("shows check-email after signup without session", async () => {
    renderApp("/login");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.type(screen.getByRole("textbox", { name: /email/i }), "new@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Check your email" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(/new@example.com/i);
    });
    expect(screen.queryByRole("link", { name: "LLM inference" })).not.toBeInTheDocument();
  });

  it("shows email-not-confirmed on sign-in before confirmation", async () => {
    renderApp("/login");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Sign up" }));
    await user.type(screen.getByRole("textbox", { name: /email/i }), "pending@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Check your email" });
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));

    await user.clear(screen.getByRole("textbox", { name: /email/i }));
    await user.type(screen.getByRole("textbox", { name: /email/i }), "pending@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/email not confirmed/i);
    });
  });

  it("navigates to forgot password", async () => {
    renderApp("/login");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /forgot password/i }));
    expect(screen.getByRole("heading", { name: "Forgot password" })).toBeInTheDocument();
  });
});
