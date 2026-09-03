import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { config } from "@/config";

async function enableMocks() {
  if (!config.useMocks) {
    return;
  }
  const { worker } = await import("@/mocks/browser");
  await worker.start({ onUnhandledRequest: "error" });
}

void enableMocks().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
