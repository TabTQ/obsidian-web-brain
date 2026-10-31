import { api, type Settings } from "../api";
import { clear, h } from "../dom";
import { mcpCommand } from "./auth";
import { gitSetupPanel } from "./git";
import { Modal, notice } from "./modal";

export function openSettings(opts: { tab?: string; onChange: () => void; prefs: { livePreview: boolean; setLivePreview: (v: boolean) => void } }) {
  const m = new Modal("Settings", "modal-settings");
  const nav = h("div", { class: "settings-nav" });
  const body = h("div", { class: "settings-body" });
  m.content.append(h("div", { class: "settings-layout" }, nav, body));
  const tabs: Record<string, () => Promise<HTMLElement> | HTMLElement> = {
    Vault: vaultTab,
    Editor: () => editorTab(opts.prefs),
    "MCP access": mcpTab,
    "Git sync": () => h("div", null, h("h3", null, "Git backup & sync"), gitSetupPanel(opts.onChange)),
    Security: securityTab,
    Trash: () => trashTab(opts.onChange),
  };
  const show = async (name: string) => {
    nav.querySelectorAll(".settings-nav-item").forEach((e) => e.classList.toggle("is-active", (e as HTMLElement).dataset.tab === name));
    clear(body);
    body.append(await tabs[name]());
  };
  for (const name of Object.keys(tabs)) nav.append(h("div", { class: "settings-nav-item", dataset: { tab: name }, onclick: () => void show(name) }, name));
  m.open();
  void show(opts.tab && tabs[opts.tab] ? opts.tab : "Vault");
}

async function vaultTab() {
  const s = await api.settings();
  const field = (label: string, key: keyof Settings, desc: string, placeholder = "") => {
    const input = h("input", { class: "input", value: s[key], placeholder }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      try {
        const next = await api.saveSettings({ [key]: input.value });
        input.value = next[key];
        notice("Saved", "success", 1200);
      } catch (e) {
        notice((e as Error).message, "error");
      }
    });
    return h("div", { class: "setting" }, h("div", { class: "setting-info" }, h("div", { class: "setting-name" }, label), h("div", { class: "setting-desc" }, desc)), input);
  };
  return h(
    "div",
    null,
    h("h3", null, "Daily notes"),
    field("Date format", "dailyFormat", "Moment-style format for the file name, e.g. YYYY-MM-DD.", "YYYY-MM-DD"),
    field("Folder", "dailyFolder", "Folder for new daily notes (empty = vault root).", "Journal"),
    field("Template", "dailyTemplate", "Template note applied to new daily notes.", "Templates/Daily"),
    h("h3", null, "Templates"),
    field("Template folder", "templatesFolder", "Notes in this folder are offered by “Insert template”. Variables: {{title}}, {{date}}, {{time}}, {{date:FORMAT}}, {{time:FORMAT}}.", "Templates"),
    h("h3", null, "Files"),
    field("Default location for new notes", "newNoteFolder", "Empty = vault root.", ""),
    field("Attachment folder", "attachmentFolder", "Where pasted/dropped files go (empty = vault root, ./sub = next to the note).", "Attachments"),
  );
}

function editorTab(prefs: { livePreview: boolean; setLivePreview: (v: boolean) => void }) {
  const cb = h("input", { type: "checkbox", checked: prefs.livePreview }) as HTMLInputElement;
  cb.addEventListener("change", () => prefs.setLivePreview(cb.checked));
  return h(
    "div",
    null,
    h("h3", null, "Editor"),
    h("div", { class: "setting" }, h("div", { class: "setting-info" }, h("div", { class: "setting-name" }, "Live preview"), h("div", { class: "setting-desc" }, "Render markdown while editing. Toggle per note with Ctrl/Cmd+E.")), cb),
    h("h3", null, "Shortcuts"),
    h(
      "table",
      { class: "shortcuts" },
      ...[
        ["Ctrl/Cmd + O", "Quick switcher"],
        ["Ctrl/Cmd + P", "Command palette"],
        ["Ctrl/Cmd + N", "New note"],
        ["Ctrl/Cmd + E", "Toggle live preview / source"],
        ["Ctrl/Cmd + Shift + F", "Search vault"],
        ["Ctrl/Cmd + Shift + D", "Open today's daily note"],
        ["Ctrl/Cmd + B / I / K", "Bold / italic / wikilink"],
        ["Ctrl/Cmd + F", "Find in note"],
        ["Ctrl/Cmd + W", "Close tab"],
      ].map(([k, v]) => h("tr", null, h("td", null, h("kbd", null, k)), h("td", null, v))),
    ),
  );
}

async function mcpTab() {
  const { token } = await api.token();
  const tokenBox = h("pre", { class: "token-box" }, token);
  const cmdBox = h("pre", { class: "code-box" }, mcpCommand(token));
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => notice("Copied", "success", 1200));
  return h(
    "div",
    null,
    h("h3", null, "Shared memory MCP"),
    h("p", { class: "muted" }, "Claude Code on any of your devices (on the tailnet) can use this vault as shared memory through the MCP endpoint ", h("code", null, location.origin + "/mcp"), "."),
    h("div", { class: "setting-name" }, "Token"),
    tokenBox,
    h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => copy(tokenBox.textContent ?? "") }, "Copy token")),
    h("div", { class: "setting-name" }, "Add to Claude Code (run on each device)"),
    cmdBox,
    h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => copy(cmdBox.textContent ?? "") }, "Copy command")),
    h("h3", null, "Rotate token"),
    h("p", { class: "muted" }, "Generates a new token. Every device must be updated with the new command."),
    h(
      "button",
      {
        class: "btn btn-danger",
        onclick: async () => {
          if (!confirm("Rotate the MCP token? All devices must be reconfigured.")) return;
          const r = await api.rotateToken();
          tokenBox.textContent = r.token;
          cmdBox.textContent = mcpCommand(r.token);
          notice("Token rotated", "success");
        },
      },
      "Rotate token",
    ),
  );
}

function securityTab() {
  const cur = h("input", { class: "input", type: "password", placeholder: "Current password", autocomplete: "current-password" }) as HTMLInputElement;
  const next = h("input", { class: "input", type: "password", placeholder: "New password (min 8)", autocomplete: "new-password" }) as HTMLInputElement;
  return h(
    "div",
    null,
    h("h3", null, "Change password"),
    cur,
    next,
    h(
      "div",
      { class: "btn-row" },
      h(
        "button",
        {
          class: "btn btn-primary",
          onclick: async () => {
            try {
              await api.changePassword(cur.value, next.value);
              notice("Password changed. Other sessions were signed out.", "success");
              cur.value = next.value = "";
            } catch (e) {
              notice((e as Error).message, "error");
            }
          },
        },
        "Change password",
      ),
      h("button", { class: "btn", onclick: async () => { await api.logout(); location.reload(); } }, "Log out"),
    ),
  );
}

async function trashTab(onChange: () => void) {
  const list = h("div", { class: "trash-list" });
  const render = async () => {
    clear(list);
    const items = (await api.trash()).sort((a, b) => b.mtime - a.mtime);
    if (!items.length) list.append(h("p", { class: "muted" }, "Trash is empty."));
    for (const it of items) {
      list.append(
        h(
          "div",
          { class: "trash-item" },
          h("span", null, it.path),
          h("span", { class: "muted" }, new Date(it.mtime).toLocaleString()),
          h("button", { class: "btn btn-small", onclick: async () => { try { const r = await api.restore(it.path); notice(`Restored to ${r.path}`, "success"); onChange(); void render(); } catch (e) { notice((e as Error).message, "error"); } } }, "Restore"),
        ),
      );
    }
  };
  await render();
  return h("div", null, h("h3", null, "Trash"), h("p", { class: "muted" }, "Deleted notes are kept in .trash (not synced to git; earlier versions remain in git history)."), list);
}
