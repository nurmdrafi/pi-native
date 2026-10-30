import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

const stored = localStorage.getItem("dash-theme");
const prefersDark =
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", stored ? stored === "dark" : prefersDark);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
