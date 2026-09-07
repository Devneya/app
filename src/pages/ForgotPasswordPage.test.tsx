import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_USER } from "@/mocks/data";
import { authBaseUrl } from "@/config";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";

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

  it("shows a provider failure instead of claiming a reset was sent", async () => {
    server.use(
      http.post(`${authBaseUrl()}/recover`, () =>
        HttpResponse.json(
          { error: "server_error", error_description: "Recovery provider unavailable" },
          { status: 503 }
        )
      )
    );
    renderApp("/forgot-password");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: /email/i }), MOCK_USER.email);
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Could not send reset link");
      expect(screen.queryByText(/a reset link is on its way/i)).not.toBeInTheDocument();
    });
  });
});
