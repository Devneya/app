import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { AppProviders, AppRoutes } from "@/App";

export function renderApp(route = "/", options?: Omit<RenderOptions, "wrapper">) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </AppProviders>
    );
  }

  return render(<AppRoutes />, { wrapper: Wrapper, ...options });
}

export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  return render(ui, options);
}
