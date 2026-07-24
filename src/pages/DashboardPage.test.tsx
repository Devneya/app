import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_USER, MOCK_VIRTUAL_KEY } from "@/mocks/data";
import { setMockSubscribed } from "@/mocks/handlers";

async function signInViaUi() {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: /email/i }), MOCK_USER.email);
  await user.type(screen.getByLabelText(/password/i), MOCK_USER.password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("DashboardPage", () => {
  beforeEach(() => {
    setMockSubscribed(false);
  });

  it("shows virtual key after sign-in", async () => {
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      expect(screen.getByText(MOCK_VIRTUAL_KEY)).toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeInTheDocument();
    });
  });
});
