import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { TaskStoreProvider } from "./task-store";
import { UiProvider } from "./ui-store";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <TaskStoreProvider>
          <UiProvider>
            <App />
          </UiProvider>
        </TaskStoreProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
