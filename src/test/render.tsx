import { render, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { AppProviders, AppRoutes } from "@/App";
import { supabase } from "@/supabase";

export function renderApp(route = "/", options?: Omit<RenderOptions, "wrapper">) {
  vi.spyOn(supabase.auth, "initialize").mockResolvedValue({ error: null });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </AppProviders>
    );
  }

  return render(<AppRoutes />, { wrapper: Wrapper, ...options });
}
