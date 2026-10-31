// First-run setup and login screens.

import { api, ApiError } from "../api";
import { h } from "../dom";

export function setupScreen(root: HTMLElement, done: (token: string) => void) {
  const code = h("input", { class: "input", placeholder: "Setup code", autocomplete: "one-time-code", autofocus: true }) as HTMLInputElement;
  const pw = h("input", { class: "input", type: "password", placeholder: "New password (min 8 characters)", autocomplete: "new-password" }) as HTMLInputElement;
  const pw2 = h("input", { class: "input", type: "password", placeholder: "Repeat password", autocomplete: "new-password" }) as HTMLInputElement;
  const err = h("div", { class: "auth-error" });
  const submit = async (e: Event) => {
    e.preventDefault();
    err.textContent = "";
    if (pw.value !== pw2.value) return void (err.textContent = "Passwords do not match");
    try {
      const r = await api.setup(code.value.trim(), pw.value);
      done(r.mcpToken);
    } catch (x) {
      err.textContent = (x as Error).message;
    }
  };
  root.replaceChildren(
    h(
      "div",
      { class: "auth-screen" },
      h(
        "form",
        { class: "auth-box", onsubmit: submit },
        h("h1", null, "Welcome to Brain"),
        h("p", { class: "muted" }, "First-run setup. Enter the one-time setup code from the server log (", h("code", null, "journalctl -u brain"), ") or from ", h("code", null, "setup-code.txt"), " in the data directory, then choose a password."),
        code,
        pw,
        pw2,
        err,
        h("button", { class: "btn btn-primary", type: "submit" }, "Create vault"),
      ),
    ),
  );
  code.focus();
}

export function showTokenScreen(root: HTMLElement, token: string, next: () => void) {
  root.replaceChildren(
    h(
      "div",
      { class: "auth-screen" },
      h(
        "div",
        { class: "auth-box wide" },
        h("h1", null, "Your MCP token"),
        h("p", { class: "muted" }, "Claude Code on your devices uses this token to reach the brain. It is also shown later in Settings → MCP access."),
        h("pre", { class: "token-box" }, token),
        h("p", { class: "muted" }, "Add it to Claude Code on each device:"),
        h("pre", { class: "code-box" }, mcpCommand(token)),
        h("button", { class: "btn btn-primary", onclick: next }, "Continue to set up git sync"),
      ),
    ),
  );
}

export function mcpCommand(token: string) {
  return `claude mcp add --transport http --scope user brain ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;
}

export function loginScreen(root: HTMLElement, done: () => void) {
  const pw = h("input", { class: "input", type: "password", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
  const err = h("div", { class: "auth-error" });
  const submit = async (e: Event) => {
    e.preventDefault();
    err.textContent = "";
    try {
      await api.login(pw.value);
      done();
    } catch (x) {
      err.textContent = x instanceof ApiError ? x.message : String(x);
      pw.select();
    }
  };
  root.replaceChildren(
    h("div", { class: "auth-screen" }, h("form", { class: "auth-box", onsubmit: submit }, h("h1", null, "Brain"), pw, err, h("button", { class: "btn btn-primary", type: "submit" }, "Unlock"))),
  );
  pw.focus();
}
