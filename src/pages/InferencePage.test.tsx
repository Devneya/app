import { describe, expect, it, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { MOCK_MODELS, MOCK_USER, MOCK_VIRTUAL_KEY } from "@/mocks/data";
import { setMockSubscribed } from "@/mocks/handlers";

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
      expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeInTheDocument();
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
