import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "@/test/render";

describe("ProtectedRoute", () => {
  it("redirects unauthenticated users to login", async () => {
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Devneya" })).toBeInTheDocument();
    expect(screen.queryByText("Devneya Account")).not.toBeInTheDocument();
  });
});
