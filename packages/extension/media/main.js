// Ripieno room webview. Plain script (not bundled/type-checked —
// esbuild.js only bundles src/extension.ts), so a couple of tiny helpers
// that exist in @ripieno/protocol are duplicated here by hand; keep them in
// sync manually if the protocol package changes.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const transcriptEl = document.getElementById("transcript");
  const rosterEl = document.getElementById("roster");
  const roomLabelEl = document.getElementById("roomLabel");
  const statusPillEl = document.getElementById("statusPill");
  const composerEl = document.getElementById("composer");
  const sendButtonEl = document.getElementById("sendButton");
  const composerBarEl = document.getElementById("composerBar");
  const actionsEl = document.getElementById("actions");
  const actionsSummaryEl = document.getElementById("actionsSummary");
  const actionsListEl = document.getElementById("actionsList");

  /** @type {"connecting"|"online"|"offline"} */
  let connection = "offline";
  let status = "idle";
  let waitingOn;
  let roster = [];
  let currentRoom;
  let actions = [];

  /** entryId -> { container, textEl } for rows currently in the DOM. */
  const rowEls = new Map();
  /** entryId -> accumulated raw text while an agent reply is streaming. */
  const liveDeltaText = new Map();

  /* ---------------------------------------------------------------- */
  /* Mirrors colorIndexFor() from @ripieno/protocol — kept identical so    */
  /* every client (including this one) picks the same hue per handle. */
  /* ---------------------------------------------------------------- */
  function colorIndexFor(handle) {
    let h = 0;
    for (let i = 0; i < handle.length; i++) {
      h = (h * 31 + handle.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 8;
  }

  /* ---------------------------------------------------------------- */
  /* Safe minimal markdown: escape everything, then reintroduce a      */
  /* handful of tags around already-escaped text. Never innerHTML raw  */
  /* model/user text directly.                                        */
  /* ---------------------------------------------------------------- */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(escapedSegment) {
    let html = escapedSegment.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
    html = html.replace(/\*\*([^\n*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`);
    return html;
  }

  function renderMarkdown(raw) {
    const parts = raw.split(/(```[\s\S]*?```)/g);
    return parts
      .map((part) => {
        if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) {
          const inner = part.slice(3, -3);
          const firstNewline = inner.indexOf("\n");
          const code = firstNewline >= 0 ? inner.slice(firstNewline + 1) : inner;
          return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
        return renderInline(escapeHtml(part));
      })
      .join("");
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function clearEmptyState() {
    const el = transcriptEl.querySelector(".empty-state");
    if (el) {
      el.remove();
    }
  }

  function showEmptyState() {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = currentRoom
      ? "No messages yet. Say hello!"
      : "Join a room to start chatting with the shared agent.";
    transcriptEl.appendChild(empty);
  }

  function buildRow(kind, authorHandle, authorName, text) {
    const container = document.createElement("div");
    container.className = `row ${kind}`;

    if (kind === "system") {
      const t = document.createElement("div");
      t.className = "system-text";
      t.textContent = text;
      container.appendChild(t);
      return { container, textEl: t, isSystem: true };
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    // In BYO mode an agent reply belongs to a member: the server sets
    // authorHandle to its owner. Carrying their hue through is what makes
    // divergence between two members' agents visible instead of confusing.
    const owned = kind === "agent" && authorHandle !== "agent";
    if (kind === "human" || owned) {
      const hue = colorIndexFor(authorHandle);
      bubble.style.setProperty("--ripieno-hue", `var(--ripieno-hue-${hue})`);
    }
    if (owned) {
      bubble.classList.add("owned");
    }

    const author = document.createElement("div");
    author.className = "author";
    // Trust the server's label — "Agent" when hosted, "Sam's agent" in BYO.
    author.textContent = authorName;
    bubble.appendChild(author);

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.innerHTML = renderMarkdown(text);
    bubble.appendChild(textEl);

    container.appendChild(bubble);
    return { container, textEl, isSystem: false };
  }

  function renderFinalEntry(entry) {
    const row = buildRow(entry.kind, entry.authorHandle, entry.authorName, entry.text);
    transcriptEl.appendChild(row.container);
    rowEls.set(entry.id, row);
  }

  function renderLiveBubble(entryId, text) {
    const row = buildRow("agent", "agent", "Agent", text);
    const caret = document.createElement("span");
    caret.className = "caret";
    row.textEl.appendChild(caret);
    transcriptEl.appendChild(row.container);
    rowEls.set(entryId, row);
  }

  function setBubbleText(row, text) {
    row.textEl.innerHTML = row.isSystem ? "" : renderMarkdown(text);
    if (row.isSystem) {
      row.textEl.textContent = text;
    }
  }

  function isPinnedToBottom() {
    return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  }

  function scrollToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function withAutoscroll(mutate) {
    const pinned = isPinnedToBottom();
    mutate();
    if (pinned) {
      scrollToBottom();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Header                                                            */
  /* ---------------------------------------------------------------- */

  function initials(name) {
    const trimmed = (name || "").trim();
    return trimmed.length > 0 ? trimmed[0].toUpperCase() : "?";
  }

  function renderRoster() {
    rosterEl.innerHTML = "";
    for (const member of roster) {
      const chip = document.createElement("div");
      chip.className = "chip" + (member.present ? "" : " absent");
      chip.style.background = `hsl(var(--ripieno-hue-${member.color}) 70% 42%)`;
      chip.title = member.displayName + (member.present ? "" : " (away)");
      chip.textContent = initials(member.displayName || member.handle);
      if (member.present) {
        const dot = document.createElement("span");
        dot.className = "dot";
        chip.appendChild(dot);
      }
      rosterEl.appendChild(chip);
    }
  }

  function statusClass() {
    if (connection === "connecting") {
      return "thinking";
    }
    if (connection === "offline") {
      return "offline";
    }
    if (status === "thinking" || status === "awaiting-tool") {
      return "thinking";
    }
    if (status === "error") {
      return "error";
    }
    return "idle";
  }

  function statusLabel() {
    if (connection === "connecting") {
      return "connecting…";
    }
    if (connection === "offline") {
      return "offline";
    }
    switch (status) {
      case "thinking":
        return "thinking…";
      case "awaiting-tool":
        return waitingOn ? `waiting on @${waitingOn}` : "waiting…";
      case "error":
        return "error";
      default:
        return "idle";
    }
  }

  function renderStatusPill() {
    statusPillEl.textContent = statusLabel();
    statusPillEl.className = `status-pill ${statusClass()}`;
  }

  function updateComposerState() {
    const offline = connection !== "online";
    composerEl.disabled = offline;
    sendButtonEl.disabled = offline || composerEl.value.trim().length === 0;
    composerEl.placeholder =
      connection === "connecting"
        ? "Connecting…"
        : connection === "offline"
          ? "Offline — messages can't be sent"
          : "Message the room…";
  }

  /* ---------------------------------------------------------------- */
  /* Message handling from the extension host                         */
  /* ---------------------------------------------------------------- */

  function applySnapshot(msg) {
    connection = msg.connection;
    status = msg.status;
    waitingOn = msg.waitingOn;
    roster = msg.roster;
    actions = msg.actions || [];
    currentRoom = msg.room;
    // Name the driver: the same product has very different capability in each
    // mode, so the room should never leave members guessing which one they have.
    const modeLabel = msg.mode === "hosted" ? " · hosted" : msg.mode === "byo" ? " · BYO" : "";
    roomLabelEl.textContent = msg.room ? `Room: ${msg.room}${modeLabel}` : "Not connected";

    transcriptEl.innerHTML = "";
    rowEls.clear();
    liveDeltaText.clear();

    if (msg.transcript.length === 0 && msg.liveDeltas.length === 0) {
      showEmptyState();
    } else {
      for (const entry of msg.transcript) {
        renderFinalEntry(entry);
      }
      for (const [entryId, text] of msg.liveDeltas) {
        liveDeltaText.set(entryId, text);
        renderLiveBubble(entryId, text);
      }
    }

    renderRoster();
    renderActions();
    renderStatusPill();
    updateComposerState();
    scrollToBottom();
  }

  function applyEntry(entry) {
    liveDeltaText.delete(entry.id);
    withAutoscroll(() => {
      clearEmptyState();
      const existing = rowEls.get(entry.id);
      if (existing) {
        // Reconcile: the authoritative final text always wins over whatever
        // deltas had accumulated.
        setBubbleText(existing, entry.text);
      } else {
        renderFinalEntry(entry);
      }
    });
  }

  function applyDelta(entryId, text) {
    const acc = (liveDeltaText.get(entryId) ?? "") + text;
    liveDeltaText.set(entryId, acc);
    withAutoscroll(() => {
      clearEmptyState();
      const existing = rowEls.get(entryId);
      if (existing) {
        existing.textEl.innerHTML = renderMarkdown(acc);
        const caret = document.createElement("span");
        caret.className = "caret";
        existing.textEl.appendChild(caret);
      } else {
        renderLiveBubble(entryId, acc);
      }
    });
  }

  /* The preview never became a message — remove it, so this view agrees with
     one that has just been reloaded from the transcript. */
  function applyDeltaCancel(entryId) {
    liveDeltaText.delete(entryId);
    const row = rowEls.get(entryId);
    if (!row) {
      return;
    }
    rowEls.delete(entryId);
    withAutoscroll(() => {
      row.container.remove();
      if (transcriptEl.childElementCount === 0) {
        showEmptyState();
      }
    });
  }

  function applyRoster(newRoster) {
    roster = newRoster;
    renderRoster();
  }

  function applyStatus(newStatus, newWaitingOn) {
    status = newStatus;
    waitingOn = newWaitingOn;
    renderStatusPill();
  }

  function applyConnection(state) {
    connection = state;
    renderStatusPill();
    updateComposerState();
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "snapshot":
        applySnapshot(msg);
        break;
      case "entry":
        applyEntry(msg.entry);
        break;
      case "delta":
        applyDelta(msg.entryId, msg.text);
        break;
      case "deltaCancel":
        applyDeltaCancel(msg.entryId);
        break;
      case "roster":
        applyRoster(msg.roster);
        break;
      case "status":
        applyStatus(msg.status, msg.waitingOn);
        break;
      case "connection":
        applyConnection(msg.state);
        break;
      case "approval":
        showApproval(msg);
        break;
      case "action":
        addAction(msg.entry);
        break;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Action log — what agents did, as opposed to what people said       */
  /* ---------------------------------------------------------------- */

  /* Kept out of the transcript deliberately: work and conversation are
     different streams, and mixing them buries both. Every row names the acting
     agent and whose workspace it touched, because with a shared workspace those
     are frequently different people. */
  function addAction(entry) {
    actions.push(entry);
    renderActions();
  }

  function renderActions() {
    if (actions.length === 0) {
      actionsEl.hidden = true;
      return;
    }
    actionsEl.hidden = false;
    actionsSummaryEl.textContent = `Work — ${actions.length} action${actions.length === 1 ? "" : "s"}`;

    actionsListEl.innerHTML = "";
    for (const entry of actions.slice(-50)) {
      const row = document.createElement("div");
      row.className = "action-row" + (entry.ok ? "" : " failed");

      const who = document.createElement("span");
      who.className = "action-who";
      who.style.color = `hsl(var(--ripieno-hue-${colorIndexFor(entry.agentId || entry.agentLabel)}) 75% 55%)`;
      who.textContent = entry.agentLabel;
      row.appendChild(who);

      const what = document.createElement("span");
      what.className = "action-what";
      // textContent throughout: these strings are paths and commands chosen by
      // a model, and this panel is read by people deciding whether to trust it.
      what.textContent = ` ${entry.verb} ${entry.target}`;
      row.appendChild(what);

      if (entry.detail) {
        const detail = document.createElement("span");
        detail.className = "action-detail";
        detail.textContent = ` ${entry.detail}`;
        row.appendChild(detail);
      }

      const where = document.createElement("span");
      where.className = "action-where";
      where.textContent = ` on @${entry.targetHandle}`;
      row.appendChild(where);

      actionsListEl.appendChild(row);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Permission requests                                               */
  /* ---------------------------------------------------------------- */

  /* Rendered inline above the composer rather than as a modal: a modal steals
     focus from the whole window and hides the conversation that explains why
     the agent is asking. */
  function showApproval(msg) {
    const card = document.createElement("div");
    card.className = "approval";

    const title = document.createElement("div");
    title.className = "approval-title";
    title.textContent = `${msg.agentLabel} wants to run ${msg.toolName}`;
    card.appendChild(title);

    const body = document.createElement("pre");
    body.className = "approval-body";
    // textContent, never innerHTML: this string is the agent's own tool input.
    body.textContent = msg.summary;
    card.appendChild(body);

    const note = document.createElement("div");
    note.className = "approval-note";
    note.textContent =
      "Requested by an agent in a shared room — other members' messages influence what it asks for.";
    card.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const choose = (choice) => {
      vscode.postMessage({ type: "approvalVerdict", id: msg.id, choice });
      card.remove();
      updateComposerState();
    };
    for (const [label, choice, primary] of [
      ["Allow once", "once", true],
      ["Always allow", "always", false],
      ["Deny", "deny", false],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = primary ? "approval-button primary" : "approval-button";
      button.addEventListener("click", () => choose(choice));
      actions.appendChild(button);
    }
    card.appendChild(actions);

    composerBarEl.parentNode.insertBefore(card, composerBarEl);
    withAutoscroll(() => {});
  }

  /* ---------------------------------------------------------------- */
  /* Composer                                                          */
  /* ---------------------------------------------------------------- */

  function autoGrow() {
    composerEl.style.height = "auto";
    composerEl.style.height = Math.min(composerEl.scrollHeight, 160) + "px";
  }

  function trySend() {
    const text = composerEl.value.trim();
    if (!text || composerEl.disabled) {
      return;
    }
    vscode.postMessage({ type: "send", text });
    composerEl.value = "";
    autoGrow();
    updateComposerState();
  }

  /* ---------------------------------------------------------------- */
  /* @-mentions                                                        */
  /* ---------------------------------------------------------------- */

  /*
   * Picking from a list beats guessing at what someone typed.
   *
   * Addressing used to rest on matching free text against labels, and it failed
   * the way free text does — "miras agent" named nobody, so every agent answered
   * and the wrong one replied. A chosen suggestion inserts a canonical token, so
   * the ambiguity never arises. The matcher still exists for people who type it
   * out; this makes not doing so the easy path.
   */
  const mentionsEl = document.getElementById("mentions");
  let candidates = [];
  let highlighted = 0;
  let mentionStart = -1;

  /** Everyone and everything addressable, people first. */
  function addressable() {
    const out = [];
    for (const member of roster) {
      if (member.kind === "workspace") continue;
      out.push({
        insert: "@" + member.handle,
        label: member.displayName || member.handle,
        detail: "@" + member.handle + (member.present ? "" : " · away"),
        kind: "person",
        color: member.color,
      });
      for (const agent of member.agents || []) {
        out.push({
          insert: agent.label,
          label: agent.label,
          detail: "agent · " + (member.displayName || member.handle),
          kind: "agent",
          color: member.color,
        });
      }
    }
    return out;
  }

  /** The @word the caret is sitting in, or null. */
  function activeMention() {
    if (composerEl.selectionStart !== composerEl.selectionEnd) return null;
    const upto = composerEl.value.slice(0, composerEl.selectionStart);
    const at = upto.lastIndexOf("@");
    if (at === -1) return null;
    // Only immediately after whitespace or at the very start, so an email
    // address does not open a member picker.
    if (at > 0 && !/\s/.test(upto[at - 1])) return null;
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { at, query: query.toLowerCase() };
  }

  function closeMentions() {
    mentionsEl.hidden = true;
    mentionsEl.innerHTML = "";
    candidates = [];
    mentionStart = -1;
  }

  function refreshMentions() {
    const active = activeMention();
    if (!active) {
      closeMentions();
      return;
    }
    candidates = addressable().filter(
      (c) =>
        active.query === "" ||
        c.label.toLowerCase().includes(active.query) ||
        c.insert.toLowerCase().includes(active.query)
    );
    if (candidates.length === 0) {
      closeMentions();
      return;
    }
    mentionStart = active.at;
    highlighted = 0;
    renderMentions();
  }

  function renderMentions() {
    mentionsEl.innerHTML = "";
    candidates.forEach((c, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention" + (i === highlighted ? " active" : "");

      const swatch = document.createElement("span");
      swatch.className = "mention-swatch";
      swatch.style.background = `hsl(var(--ripieno-hue-${c.color}) 70% 42%)`;
      swatch.textContent = c.kind === "agent" ? "\u2699" : initials(c.label);
      row.appendChild(swatch);

      const name = document.createElement("span");
      name.className = "mention-name";
      name.textContent = c.label;
      row.appendChild(name);

      const detail = document.createElement("span");
      detail.className = "mention-detail";
      detail.textContent = c.detail;
      row.appendChild(detail);

      // mousedown, not click: the textarea must not lose focus first.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        accept(i);
      });
      mentionsEl.appendChild(row);
    });
    mentionsEl.hidden = false;
  }

  function accept(index) {
    const chosen = candidates[index];
    if (!chosen || mentionStart < 0) return;
    const before = composerEl.value.slice(0, mentionStart);
    const after = composerEl.value.slice(composerEl.selectionStart);
    const insert = chosen.insert + " ";
    composerEl.value = before + insert + after;
    const caret = before.length + insert.length;
    composerEl.setSelectionRange(caret, caret);
    closeMentions();
    composerEl.focus();
    autoGrow();
    updateComposerState();
  }

  composerEl.addEventListener("input", () => {
    autoGrow();
    updateComposerState();
    refreshMentions();
  });

  composerEl.addEventListener("blur", closeMentions);

  composerEl.addEventListener("keydown", (e) => {
    if (!mentionsEl.hidden && candidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        highlighted = (highlighted + step + candidates.length) % candidates.length;
        renderMentions();
        return;
      }
      // Enter accepts the suggestion rather than sending — sending a half-typed
      // name to the room is the mistake this exists to prevent.
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(highlighted);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentions();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  });

  sendButtonEl.addEventListener("click", trySend);

  /* ---------------------------------------------------------------- */
  /* Boot                                                               */
  /* ---------------------------------------------------------------- */

  renderStatusPill();
  updateComposerState();
  vscode.postMessage({ type: "ready" });
})();
