// Git status bar, setup wizard, and conflict resolver.

import { api, type Conflict, type GitStatus } from "../api";
import { clear, h, icon } from "../dom";
import { notice } from "./modal";

function ago(t: number | null) {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleString();
}

export function renderGitStatus(el: HTMLElement, s: GitStatus | null, actions: { openConflicts: () => void; openSettings: () => void }) {
  clear(el);
  if (!s || !s.enabled) {
    el.append(h("span", { class: "status-item clickable", title: "Connect a git repository for backup", onclick: actions.openSettings }, icon("git", 14), " Git: not set up"));
    return;
  }
  if (s.conflicts.length) {
    el.append(h("span", { class: "status-item status-warn clickable", onclick: actions.openConflicts }, icon("alert", 14), ` ${s.conflicts.length} sync conflict${s.conflicts.length > 1 ? "s" : ""} — resolve`));
    return;
  }
  const parts: string[] = [];
  if (s.busy) parts.push(`${s.busy}…`);
  else if (s.pendingCommit) parts.push("saving to git…");
  else if (s.ahead > 0) parts.push(`↑${s.ahead}` + (s.nextPushAt ? ` push in ${Math.max(0, Math.round((s.nextPushAt - Date.now()) / 1000))}s` : ""));
  else parts.push(`synced ${ago(s.lastPushAt ?? s.lastFetchAt)}`);
  if (s.behind > 0) parts.push(`↓${s.behind}`);
  const item = h("span", { class: "status-item clickable" + (s.lastError ? " status-warn" : ""), title: s.lastError ?? `${s.remote} (${s.branch})\nClick to sync now`, onclick: () => void syncNow() }, icon(s.lastError ? "alert" : "git", 14), " " + parts.join("  "));
  el.append(item);
}

async function syncNow() {
  try {
    const s = await api.gitSync();
    notice(s.conflicts.length ? `Sync paused: ${s.conflicts.length} conflict(s)` : s.lastError ? s.lastError : "Synced", s.lastError ? "error" : "success");
  } catch (e) {
    notice((e as Error).message, "error");
  }
}

/** Git connection wizard (used in Settings and after first-run setup). */
export function gitSetupPanel(onDone: () => void): HTMLElement {
  const root = h("div", { class: "git-setup" });
  const render = async () => {
    clear(root);
    const st = await api.gitStatus();
    if (st.enabled) {
      root.append(
        h("p", null, "Connected to ", h("code", null, st.remote), " on branch ", h("code", null, st.branch), "."),
        h("p", { class: "muted" }, `Last push: ${ago(st.lastPushAt)} · last fetch: ${ago(st.lastFetchAt)} · ahead ${st.ahead} · behind ${st.behind}`),
        st.lastError ? h("p", { class: "error-text" }, st.lastError) : "",
        h(
          "div",
          { class: "btn-row" },
          h("button", { class: "btn", onclick: async () => { await api.gitCommit("Manual commit"); notice("Committed", "success"); void render(); } }, "Commit now"),
          h("button", { class: "btn btn-primary", onclick: async () => { await syncNow(); void render(); } }, "Sync now"),
          h("button", { class: "btn", onclick: async () => { const s = await api.gitPull(); notice(s.conflicts.length ? "Conflicts need resolving" : "Pulled from remote", "success"); void render(); } }, "Pull from remote"),
          h("button", { class: "btn btn-danger", onclick: async () => { if (confirm("Stop syncing with this repository? Local history is kept.")) { await api.gitDisconnect(); void render(); } } }, "Disconnect"),
        ),
        await historyList(),
      );
      return;
    }
    // Step 1: deploy key
    const keyBox = h("pre", { class: "token-box" }, st.publicKey ?? "");
    const genBtn = h("button", { class: "btn" }, st.hasKey ? "Show key" : "Generate deploy key");
    genBtn.addEventListener("click", async () => {
      const r = await api.gitKey(false);
      keyBox.textContent = r.publicKey;
      step2.hidden = false;
    });
    // Step 2: repo details
    const remote = h("input", { class: "input", placeholder: "git@github.com:you/my-vault.git" }) as HTMLInputElement;
    const branch = h("input", { class: "input", value: "main", placeholder: "Branch" }) as HTMLInputElement;
    const name = h("input", { class: "input", value: "Brain", placeholder: "Commit author name" }) as HTMLInputElement;
    const email = h("input", { class: "input", placeholder: "Commit author email" }) as HTMLInputElement;
    const fpBox = h("div", { class: "muted" });
    const status = h("div", { class: "error-text" });
    let fingerprint = "";
    const checkBtn = h("button", { class: "btn" }, "Check host key");
    const connectBtn = h("button", { class: "btn btn-primary", disabled: true }, "Connect & sync");
    checkBtn.addEventListener("click", async () => {
      status.textContent = "";
      try {
        const r = await api.gitHostKey(remote.value.trim());
        fingerprint = r.fingerprint;
        fpBox.textContent = "";
        fpBox.append(
          h("div", null, `Host ${r.host} presents key `, h("code", null, r.fingerprint)),
          r.pinned ? h("div", { class: r.matchesPinned ? "ok-text" : "error-text" }, r.matchesPinned ? "✓ Matches GitHub's published fingerprint." : "✗ Does NOT match GitHub's published fingerprint — do not continue.") : h("div", null, "Verify this fingerprint with your git host before connecting."),
        );
        connectBtn.disabled = r.pinned ? !r.matchesPinned : false;
      } catch (e) {
        status.textContent = (e as Error).message;
      }
    });
    connectBtn.addEventListener("click", async () => {
      status.textContent = "";
      connectBtn.disabled = true;
      connectBtn.textContent = "Connecting…";
      try {
        const r = await api.gitConnect({ remote: remote.value.trim(), branch: branch.value.trim() || "main", authorName: name.value.trim(), authorEmail: email.value.trim(), fingerprint });
        notice(r.conflicts.length ? `Connected. ${r.conflicts.length} file(s) need conflict resolution.` : "Connected. Vault is backed up to git.", "success", 6000);
        onDone();
        void render();
      } catch (e) {
        status.textContent = (e as Error).message;
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect & sync";
      }
    });
    const step2 = h(
      "div",
      { class: "git-step", hidden: !st.hasKey },
      h("h4", null, "2. Repository"),
      h("p", { class: "muted" }, "Create a private repository (it may be empty, or contain an existing vault). Add the key above under the repository's Settings → Deploy keys → Add deploy key, and tick “Allow write access”."),
      h("label", null, "SSH remote URL", remote),
      h("label", null, "Branch", branch),
      h("label", null, "Author name", name),
      h("label", null, "Author email", email),
      h("div", { class: "btn-row" }, checkBtn, connectBtn),
      fpBox,
      status,
    );
    root.append(
      h("div", { class: "git-step" }, h("h4", null, "1. Deploy key"), h("p", { class: "muted" }, "Brain generates an SSH key that only works for one repository."), genBtn, keyBox),
      step2,
    );
  };
  void render();
  return root;
}

async function historyList() {
  const log = await api.gitLog().catch(() => []);
  return h(
    "details",
    { class: "git-history" },
    h("summary", null, "Recent commits"),
    h("ul", null, ...log.slice(0, 20).map((c) => h("li", null, h("code", null, c.hash.slice(0, 7)), " ", c.subject, h("span", { class: "muted" }, ` — ${new Date(c.date).toLocaleString()}`)))),
  );
}

/** Conflict resolver view: per file choose vault / remote / edited merge. */
export function conflictsView(onResolved: () => void): HTMLElement {
  const root = h("div", { class: "conflicts-view" });
  const render = async () => {
    clear(root);
    const conflicts = await api.gitConflicts();
    if (!conflicts.length) {
      root.append(h("div", { class: "empty-state" }, h("h2", null, "No conflicts"), h("p", { class: "muted" }, "Everything is in sync.")));
      return;
    }
    const choices = new Map<string, { choice: "ours" | "theirs" | "manual"; content?: string }>();
    const apply = h("button", { class: "btn btn-primary", disabled: true }, "Apply resolutions & sync");
    const update = () => {
      apply.disabled = choices.size !== conflicts.length;
      apply.textContent = `Apply resolutions & sync (${choices.size}/${conflicts.length})`;
    };
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      try {
        await api.gitResolve(Object.fromEntries(choices));
        notice("Conflicts resolved and synced", "success");
        onResolved();
        void render();
      } catch (e) {
        notice((e as Error).message, "error", 8000);
        update();
      }
    });
    root.append(
      h("div", { class: "conflicts-header" }, h("h2", null, "Resolve sync conflicts"), h("p", { class: "muted" }, "These files changed both in this vault and on the remote since the last sync. Pick which version to keep for each file, or edit a merged version. Nothing is lost until you apply."), apply),
    );
    for (const c of conflicts) root.append(conflictCard(c, choices, update));
    update();
  };
  void render();
  return root;
}

function conflictCard(c: Conflict, choices: Map<string, { choice: "ours" | "theirs" | "manual"; content?: string }>, update: () => void) {
  const pane = (title: string, text: string | null) => h("div", { class: "conflict-pane" }, h("div", { class: "conflict-pane-title" }, title), text === null ? h("div", { class: "muted conflict-deleted" }, "(deleted)") : c.binary ? h("div", { class: "muted" }, "(binary file)") : h("pre", null, text));
  const editor = h("textarea", { class: "conflict-merge", hidden: true }) as HTMLTextAreaElement;
  const state = h("span", { class: "conflict-state muted" }, "Not resolved");
  const set = (choice: "ours" | "theirs" | "manual") => {
    if (choice === "manual") {
      editor.hidden = false;
      if (!editor.value) editor.value = mergeDraft(c);
      choices.set(c.path, { choice, content: editor.value });
      state.textContent = "Keeping edited merge";
    } else {
      editor.hidden = true;
      choices.set(c.path, { choice });
      state.textContent = choice === "ours" ? "Keeping vault version" : "Keeping remote version";
    }
    card.querySelectorAll(".conflict-choice").forEach((b) => b.classList.toggle("is-active", (b as HTMLElement).dataset.choice === choice));
    update();
  };
  editor.addEventListener("input", () => {
    choices.set(c.path, { choice: "manual", content: editor.value });
  });
  const btn = (label: string, choice: "ours" | "theirs" | "manual") => h("button", { class: "btn conflict-choice", dataset: { choice }, onclick: () => set(choice) }, label);
  const card = h(
    "div",
    { class: "conflict-card" },
    h("div", { class: "conflict-title" }, h("strong", null, c.path), state),
    h("div", { class: "conflict-panes" }, pane("This vault", c.ours), pane("Remote (GitHub)", c.theirs)),
    h("div", { class: "btn-row" }, btn("Keep vault version", "ours"), btn("Keep remote version", "theirs"), c.binary ? null : btn("Edit merged version", "manual")),
    editor,
  );
  return card;
}

function mergeDraft(c: Conflict) {
  const ours = c.ours ?? "";
  const theirs = c.theirs ?? "";
  if (!ours) return theirs;
  if (!theirs) return ours;
  return `${ours}\n\n<!-- ===== remote version below — merge and delete this marker ===== -->\n\n${theirs}`;
}
