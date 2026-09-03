import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_MODELS, MOCK_USER, MOCK_VIRTUAL_KEY } from "@/mocks/data";
import { setMockBillingState, setMockSubscribed } from "@/mocks/handlers";

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

  it("shows virtual key after sign-in", async () => {
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      expect(screen.getByText(MOCK_VIRTUAL_KEY)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "LLM inference" })).toBeInTheDocument();
      expect(screen.getByText("[Devneya]")).toBeInTheDocument();
      expect(screen.queryByText(/\/ llm inference/i)).not.toBeInTheDocument();
    });
  });

  it("lists available models", async () => {
    renderApp("/login");
    await signInViaUi();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Available models" })).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "Available models" })).toBeInTheDocument();
    });
    for (const id of MOCK_MODELS) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
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
      expect(screen.getByText(/Spent:/)).toHaveTextContent("Spent: $0.42 / $10.00");
      expect(screen.getByRole("progressbar", { name: "Usage progress" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeInTheDocument();
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
    ["pending", "none", "alert", "Payment confirmation is pending."],
    ["deleting", "none", "alert", "Account deletion is in progress."],
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
});
