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
  const modeBadgeEl = document.getElementById("modeBadge");
  const statusPillEl = document.getElementById("statusPill");
  const composerEl = document.getElementById("composer");
  const composerValidationEl = document.getElementById("composerValidation");
  const sendButtonEl = document.getElementById("sendButton");
  const actionsEl = document.getElementById("actions");
  const actionsSummaryEl = document.getElementById("actionsSummary");
  const actionsListEl = document.getElementById("actionsList");
  const approvalStackEl = document.getElementById("approvalStack");
  const jumpLatestEl = document.getElementById("jumpLatest");
  // Mirrors MAX_COMPOSER_CHARS in roomViewMessages.ts. The host remains the
  // authority; this copy prevents a legitimate draft being cleared on rejection.
  const MAX_COMPOSER_CHARS = 32_000;

  /** @type {"connecting"|"online"|"offline"} */
  let connection = "offline";
  let status = "idle";
  let waitingOn;
  let roster = [];
  let currentRoom;
  let currentUser;
  let actions = [];
  let unseenEntries = 0;

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
    const title = document.createElement("strong");
    title.textContent = currentRoom ? "The room is ready" : "No room joined";
    const detail = document.createElement("span");
    detail.textContent = currentRoom
      ? "Start the conversation, or type @ to choose a person or agent."
      : "Use Ripieno: Join Room to open a shared conversation.";
    empty.append(title, detail);

    let onboarding;
    if (!currentRoom) {
      onboarding = { action: "joinRoom", label: "Join room" };
    } else if (
      currentUser &&
      currentUser.role !== "viewer" &&
      (currentUser.agents || []).length === 0
    ) {
      onboarding = { action: "attachAgent", label: "Add or attach an agent" };
    }
    if (onboarding) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "empty-action";
      button.textContent = onboarding.label;
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "onboardingAction", action: onboarding.action });
      });
      empty.appendChild(button);
    }
    transcriptEl.appendChild(empty);
  }

  function formatTime(ts) {
    if (!Number.isFinite(ts)) return "";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(ts);
  }

  function buildRow(kind, authorHandle, authorName, text, ts) {
    const container = document.createElement("div");
    container.className = `row ${kind}`;

    // Identity comes from the relay snapshot, not the display name. Two people
    // may share a name; only the authenticated handle decides which human
    // messages are ours and therefore belong on the outgoing/right side.
    const isMine = kind === "human" && currentUser?.handle === authorHandle;
    if (isMine) {
      container.classList.add("mine");
    }

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

    const authorLine = document.createElement("div");
    authorLine.className = "author-line";

    const author = document.createElement("span");
    author.className = "author";
    // Trust the server's label — "Agent" when hosted, "Sam's agent" in BYO.
    author.textContent = isMine ? "You" : authorName;
    if (isMine) author.title = authorName;
    authorLine.appendChild(author);

    const time = formatTime(ts);
    if (time) {
      const timestamp = document.createElement("time");
      timestamp.className = "timestamp";
      timestamp.dateTime = new Date(ts).toISOString();
      timestamp.title = new Date(ts).toLocaleString();
      timestamp.textContent = time;
      authorLine.appendChild(timestamp);
    }
    bubble.appendChild(authorLine);

    const textEl = document.createElement("div");
    textEl.className = "text";
    textEl.innerHTML = renderMarkdown(text);
    bubble.appendChild(textEl);

    container.appendChild(bubble);
    return { container, textEl, isSystem: false };
  }

  function renderFinalEntry(entry) {
    const row = buildRow(entry.kind, entry.authorHandle, entry.authorName, entry.text, entry.ts);
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

  function isPinnedToBottom() {
    return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
  }

  function scrollToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    unseenEntries = 0;
    jumpLatestEl.hidden = true;
  }

  function withAutoscroll(mutate, announce = false) {
    const pinned = isPinnedToBottom();
    mutate();
    if (pinned) {
      scrollToBottom();
    } else if (announce) {
      unseenEntries += 1;
      jumpLatestEl.firstChild.textContent = unseenEntries === 1 ? "New message " : `${unseenEntries} new `;
      jumpLatestEl.hidden = false;
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
    const people = roster.filter((entry) => entry.kind !== "workspace");
    const visible = people.slice(0, 5);
    for (const member of visible) {
      const chip = document.createElement("div");
      chip.className = "chip" + (member.present ? "" : " absent");
      chip.style.setProperty("--ripieno-hue", `var(--ripieno-hue-${member.color})`);
      chip.setAttribute("role", "listitem");
      const agents = member.agents || [];
      const agentState = agents.find((agent) => agent.state && agent.state !== "idle");
      const agentLabel = agents.length === 0
        ? "no agent attached"
        : `${agents.length} agent${agents.length === 1 ? "" : "s"}${agentState ? `, ${agentState.label} ${agentState.state}` : ""}`;
      const label = `${member.displayName || member.handle}, ${member.present ? "online" : "away"}, ${agentLabel}`;
      chip.title = label;
      chip.setAttribute("aria-label", label);
      chip.textContent = initials(member.displayName || member.handle);
      if (agents.length > 0) {
        const agentBadge = document.createElement("span");
        agentBadge.className = "agent-badge";
        agentBadge.setAttribute("aria-hidden", "true");
        agentBadge.textContent = agents.length > 1 ? String(agents.length) : "◆";
        chip.appendChild(agentBadge);
      }
      if (member.present) {
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.setAttribute("aria-hidden", "true");
        chip.appendChild(dot);
      }
      rosterEl.appendChild(chip);
    }
    if (people.length > visible.length) {
      const overflow = document.createElement("div");
      overflow.className = "chip roster-overflow";
      overflow.setAttribute("role", "listitem");
      overflow.setAttribute("aria-label", `${people.length - visible.length} more people in this room`);
      overflow.title = `${people.length - visible.length} more people`;
      overflow.textContent = `+${people.length - visible.length}`;
      rosterEl.appendChild(overflow);
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
    const thinkingAgent = roster
      .flatMap((member) => member.agents || [])
      .find((agent) => agent.state === "thinking");
    switch (status) {
      case "thinking":
        return thinkingAgent ? `${thinkingAgent.label} thinking…` : "thinking…";
      case "awaiting-tool":
        return waitingOn ? `waiting on @${waitingOn}` : "waiting…";
      case "error":
        return "error";
      default:
        return "idle";
    }
  }

  function renderStatusPill() {
    const label = statusLabel();
    statusPillEl.textContent = label;
    statusPillEl.title = label;
    statusPillEl.className = `status-pill ${statusClass()}`;
    statusPillEl.hidden = connection === "online" && status === "idle";
  }

  function updateComposerState() {
    const offline = connection !== "online";
    const notJoined = !currentRoom;
    const readOnly = currentUser?.role === "viewer";
    const messageLength = composerEl.value.trim().length;
    const tooLong = messageLength > MAX_COMPOSER_CHARS;
    renderComposerValidation(messageLength);
    composerEl.disabled = offline || notJoined || readOnly;
    sendButtonEl.disabled = composerEl.disabled || messageLength === 0 || tooLong;
    composerEl.placeholder =
      connection === "connecting"
        ? "Connecting…"
        : offline
          ? "Offline — messages can't be sent"
          : notJoined
            ? "Join a room to start messaging"
            : readOnly
              ? "Read-only — viewers cannot post"
              : "Message…  @ people · / commands";
  }

  function renderComposerValidation(messageLength) {
    if (messageLength <= MAX_COMPOSER_CHARS) {
      composerValidationEl.hidden = true;
      composerValidationEl.textContent = "";
      composerEl.removeAttribute("aria-invalid");
      return;
    }
    if (composerValidationEl.hidden) {
      composerValidationEl.textContent =
        `Message exceeds the ${MAX_COMPOSER_CHARS.toLocaleString()}-character limit. ` +
        "Shorten it before sending.";
    }
    composerValidationEl.hidden = false;
    composerEl.setAttribute("aria-invalid", "true");
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
    currentUser = msg.you;
    roomLabelEl.textContent = msg.room || "Not connected";
    modeBadgeEl.textContent = msg.mode === "hosted" ? "Hosted" : msg.mode === "byo" ? "BYO" : "";
    modeBadgeEl.hidden = !msg.mode;

    transcriptEl.innerHTML = "";
    rowEls.clear();
    liveDeltaText.clear();
    approvalStackEl.innerHTML = "";
    unseenEntries = 0;
    jumpLatestEl.hidden = true;

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
    for (const approval of msg.approvals || []) {
      showApproval(approval);
    }
    renderStatusPill();
    updateComposerState();
    scrollToBottom();
  }

  function applyEntry(entry) {
    const wasLive = liveDeltaText.delete(entry.id);
    withAutoscroll(() => {
      clearEmptyState();
      const existing = rowEls.get(entry.id);
      if (existing) {
        // The authoritative entry carries the author, owner colour and timestamp
        // that streaming deltas do not. Replace the whole preview row so BYO
        // provenance is correct immediately rather than only after a reload.
        const row = buildRow(entry.kind, entry.authorHandle, entry.authorName, entry.text, entry.ts);
        existing.container.replaceWith(row.container);
        rowEls.set(entry.id, row);
      } else {
        renderFinalEntry(entry);
      }
    }, !wasLive);
  }

  function applyDelta(entryId, text) {
    const wasLive = liveDeltaText.has(entryId);
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
    }, !wasLive);
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

  function applyRoster(newRoster, you) {
    roster = newRoster;
    currentUser = you;
    renderRoster();
    const empty = transcriptEl.querySelector(".empty-state");
    if (empty) {
      empty.remove();
      showEmptyState();
    }
    updateComposerState();
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
        applyRoster(msg.roster, msg.you);
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
    const failed = actions.filter((entry) => !entry.ok).length;
    const shown = Math.min(actions.length, 50);
    actionsSummaryEl.textContent = `Work · ${actions.length}${failed ? ` · ${failed} failed` : ""}`;
    actionsSummaryEl.title = actions.length > shown ? `Showing the latest ${shown} actions` : "Agent work in this room";

    actionsListEl.innerHTML = "";
    for (const entry of actions.slice(-50)) {
      const row = document.createElement("div");
      row.className = "action-row" + (entry.ok ? "" : " failed");
      row.setAttribute("role", "group");
      row.setAttribute(
        "aria-label",
        `${entry.ok ? "Succeeded" : "Failed"}: ${entry.agentLabel} ${entry.verb} ${entry.target} on ${entry.targetHandle}`
      );
      row.title = `${entry.agentLabel} ${entry.verb} ${entry.target}${entry.detail ? ` ${entry.detail}` : ""} on @${entry.targetHandle}`;

      const result = document.createElement("span");
      result.className = "action-result";
      result.textContent = entry.ok ? "✓" : "!";
      result.setAttribute("aria-hidden", "true");
      row.appendChild(result);

      const body = document.createElement("span");
      body.className = "action-body";

      const who = document.createElement("span");
      who.className = "action-who";
      who.textContent = entry.agentLabel;
      body.appendChild(who);

      const what = document.createElement("span");
      what.className = "action-what";
      // textContent throughout: these strings are paths and commands chosen by
      // a model, and this panel is read by people deciding whether to trust it.
      what.textContent = ` ${entry.verb} ${entry.target}`;
      body.appendChild(what);

      if (entry.detail) {
        const detail = document.createElement("span");
        detail.className = "action-detail";
        detail.textContent = ` ${entry.detail}`;
        body.appendChild(detail);
      }

      const where = document.createElement("span");
      where.className = "action-where";
      where.textContent = ` on @${entry.targetHandle}`;
      body.appendChild(where);
      row.appendChild(body);

      const timestamp = document.createElement("time");
      timestamp.className = "action-time";
      timestamp.dateTime = new Date(entry.ts).toISOString();
      timestamp.title = new Date(entry.ts).toLocaleString();
      timestamp.textContent = formatTime(entry.ts);
      row.appendChild(timestamp);

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
    if (approvalStackEl.querySelector(`[data-approval-id="${CSS.escape(msg.id)}"]`)) {
      return;
    }
    const pinned = isPinnedToBottom();
    const card = document.createElement("div");
    card.className = "approval";
    card.dataset.approvalId = msg.id;
    card.setAttribute("role", "region");

    const title = document.createElement("div");
    title.className = "approval-title";
    title.id = `${msg.id}_title`;
    title.textContent = `${msg.agentLabel} wants to run ${msg.toolName}`;
    card.setAttribute("aria-labelledby", title.id);
    card.appendChild(title);

    const body = document.createElement("pre");
    body.className = "approval-body";
    // textContent, never innerHTML: this string is the agent's own tool input.
    body.textContent = msg.summary;
    card.appendChild(body);

    const note = document.createElement("div");
    note.className = "approval-note";
    note.id = `${msg.id}_note`;
    note.textContent = msg.rememberable
      ? "Other members can influence this request. A remembered approval applies only to this exact request from this agent, for this editor session."
      : "Other members can influence this request. This summary does not show the full exact input, so approval can apply to this run only.";
    card.setAttribute("aria-describedby", note.id);

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const choose = (choice) => {
      vscode.postMessage({ type: "approvalVerdict", id: msg.id, choice });
      card.remove();
      updateComposerState();
    };
    const choices = [
      ["Allow once", "once", true],
      ["Deny", "deny", false],
    ];
    if (msg.rememberable) {
      choices.push(["Allow exact request", "always", false]);
    }
    for (const [label, choice, primary] of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = primary ? "approval-button primary" : "approval-button";
      if (choice === "always") {
        button.title = "Allow this same request from this agent for the rest of this editor session";
      }
      button.addEventListener("click", () => choose(choice));
      actions.appendChild(button);
    }
    card.appendChild(actions);
    card.appendChild(note);

    actionsEl.open = false;
    approvalStackEl.appendChild(card);
    if (pinned) {
      scrollToBottom();
    }
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
    if (text.length > MAX_COMPOSER_CHARS) {
      renderComposerValidation(text.length);
      sendButtonEl.disabled = true;
      return;
    }
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
  const slashCommands = [
    { insert: "/help", label: "/help", detail: "Show room commands", kind: "command", color: 5 },
    { insert: "/agents", label: "/agents", detail: "List your agents, providers and models", kind: "command", color: 5 },
    { insert: "/model", label: "/model", detail: "Choose an agent and provider model", kind: "command", color: 5 },
    { insert: "/attach", label: "/attach", detail: "Attach one of your agents", kind: "command", color: 5 },
    { insert: "/detach", label: "/detach", detail: "Detach one of your agents", kind: "command", color: 5 },
  ];
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

  function activeSlashCommand() {
    if (composerEl.selectionStart !== composerEl.selectionEnd) return null;
    const upto = composerEl.value.slice(0, composerEl.selectionStart);
    if (!/^\/[^\s]*$/.test(upto)) return null;
    return { at: 0, query: upto.toLowerCase() };
  }

  function closeMentions() {
    mentionsEl.hidden = true;
    mentionsEl.innerHTML = "";
    candidates = [];
    mentionStart = -1;
    composerEl.setAttribute("aria-expanded", "false");
    composerEl.removeAttribute("aria-activedescendant");
  }

  function refreshMentions() {
    const slash = activeSlashCommand();
    if (slash) {
      candidates = slashCommands.filter((command) => command.insert.startsWith(slash.query));
      if (candidates.length > 0) {
        mentionStart = slash.at;
        highlighted = 0;
        renderMentions();
        return;
      }
    }

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
      row.id = `mention-option-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === highlighted ? "true" : "false");

      const swatch = document.createElement("span");
      swatch.className = "mention-swatch";
      swatch.style.setProperty("--ripieno-hue", `var(--ripieno-hue-${c.color})`);
      swatch.textContent = c.kind === "agent" ? "\u2699" : c.kind === "command" ? "/" : initials(c.label);
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
      row.addEventListener("click", () => accept(i));
      mentionsEl.appendChild(row);
    });
    mentionsEl.hidden = false;
    composerEl.setAttribute("aria-expanded", "true");
    composerEl.setAttribute("aria-activedescendant", `mention-option-${highlighted}`);
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
  composerEl.addEventListener("click", refreshMentions);
  composerEl.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      refreshMentions();
    }
  });

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
  actionsSummaryEl.addEventListener("click", () => {
    const pinned = isPinnedToBottom();
    requestAnimationFrame(() => {
      if (pinned) scrollToBottom();
    });
  });
  transcriptEl.addEventListener("scroll", () => {
    if (isPinnedToBottom()) {
      unseenEntries = 0;
      jumpLatestEl.hidden = true;
    }
  });
  jumpLatestEl.addEventListener("click", scrollToBottom);

  /* ---------------------------------------------------------------- */
  /* Boot                                                               */
  /* ---------------------------------------------------------------- */

  renderStatusPill();
  updateComposerState();
  vscode.postMessage({ type: "ready" });
})();
