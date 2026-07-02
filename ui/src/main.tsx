import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { App } from "./App";

async function boot() {
  if (import.meta.env.VITE_MOCK === "1") {
    const { installMockApi } = await import("./mocks/mockApi");
    installMockApi();
  }

  const el = document.getElementById("root");
  if (!el) throw new Error("#root not found");
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
