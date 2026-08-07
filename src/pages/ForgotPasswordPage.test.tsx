import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_USER } from "@/mocks/data";

describe("ForgotPasswordPage", () => {
  it("shows confirmation after submit", async () => {
    renderApp("/forgot-password");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: /email/i }), MOCK_USER.email);
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/if an account exists/i);
    });
  });
});
