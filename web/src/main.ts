import "katex/dist/katex.min.css";
import "./styles.css";
import { api, ApiError, setUnauthorizedHandler } from "./api";
import { App } from "./ui/app";
import { loginScreen, setupScreen, showTokenScreen } from "./ui/auth";
import { gitSetupPanel } from "./ui/git";
import { h } from "./dom";

const root = document.getElementById("app")!;

function theme() {
  const pref = localStorage.getItem("brain.theme") ?? "system";
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("theme-dark", dark);
  document.documentElement.classList.toggle("theme-light", !dark);
}

async function boot() {
  theme();
  setUnauthorizedHandler(() => loginScreen(root, () => location.reload()));
  const { setupComplete } = await api.setupStatus();
  if (!setupComplete) {
    setupScreen(root, (token) =>
      showTokenScreen(root, token, () => {
        root.replaceChildren(
          h(
            "div",
            { class: "auth-screen" },
            h("div", { class: "auth-box wide" }, h("h1", null, "Back up to git"), h("p", { class: "muted" }, "Connect a private GitHub repository now, or skip and do it later in Settings → Git sync."), gitSetupPanel(() => undefined), h("button", { class: "btn", onclick: () => location.reload() }, "Continue to vault")),
          ),
        );
      }),
    );
    return;
  }
  try {
    await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return loginScreen(root, () => location.reload());
    throw e;
  }
  await new App(root).start();
}

boot().catch((e) => {
  root.textContent = `Failed to start: ${(e as Error).message}`;
});
