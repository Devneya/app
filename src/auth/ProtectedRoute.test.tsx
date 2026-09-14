import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { supabase } from "@/supabase";

describe("ProtectedRoute", () => {
  it("formats session initialization errors for display", async () => {
    vi.spyOn(supabase.auth, "getSession").mockRejectedValueOnce(
      new Error('{"message":"Session lookup failed."}')
    );
    renderApp("/");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load your session: Session lookup failed."
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent('{"message":');
  });

  it("redirects unauthenticated users to login", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Account security" })).not.toBeInTheDocument();
  });
});
