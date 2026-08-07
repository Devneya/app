import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_USER } from "@/mocks/data";

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

  it("signs in with mock credentials", async () => {
    renderApp("/login");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: /email/i }), MOCK_USER.email);
    await user.type(screen.getByLabelText(/password/i), MOCK_USER.password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Account")).toBeInTheDocument();
      expect(screen.getByText(MOCK_USER.email)).toBeInTheDocument();
    });
  });

  it("navigates to forgot password", async () => {
    renderApp("/login");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /forgot password/i }));
    expect(screen.getByRole("heading", { name: "Forgot password" })).toBeInTheDocument();
  });
});
