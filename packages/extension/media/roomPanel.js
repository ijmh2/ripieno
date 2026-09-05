// Editor-sized Room panel. It renders only the bounded display model produced
// by roomPanelState.ts; the webview never talks to the relay or provider.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const roomNameEl = document.getElementById("panelRoomName");
  const roomMetaEl = document.getElementById("panelRoomMeta");
  const connectionEl = document.getElementById("panelConnection");
  const workspaceStateEl = document.getElementById("workspaceState");
  const workspaceStateLabelEl = document.getElementById("workspaceStateLabel");
  const workspaceStateDetailEl = document.getElementById("workspaceStateDetail");
  const overviewMetricsEl = document.getElementById("overviewMetrics");
  const overviewUpdatedEl = document.getElementById("overviewUpdated");
  const roomPulseEl = document.getElementById("roomPulse");
  const filtersEl = document.getElementById("statusFilters");
  const railEl = document.getElementById("agentTabRail");
  const detailEl = document.getElementById("agentDetail");
  const filterEmptyEl = document.getElementById("filterEmpty");
  const announcementsEl = document.getElementById("panelAnnouncements");
  const claimForm = document.getElementById("claimForm");
  const claimTask = document.getElementById("claimTask");
  const claimPaths = document.getElementById("claimPaths");
  const claimAgent = document.getElementById("claimAgent");
  const claimGoal = document.getElementById("claimGoal");
  const claimFeedback = document.getElementById("claimFeedback");
  let pendingClaimAction;
  let submittedTask;

  const restored = vscode.getState() || {};
  let snapshot;
  let selectedAgentId = typeof restored.selectedAgentId === "string" ? restored.selectedAgentId : undefined;
  let followedAgentId = typeof restored.followedAgentId === "string" ? restored.followedAgentId : undefined;
  const enabledFilters = new Set(
    Array.isArray(restored.filters) ? restored.filters.filter(isStatusGroup) : ["active", "idle", "unknown"]
  );
  let lastFollowActivity;

  function isStatusGroup(value) {
    return value === "active" || value === "idle" || value === "unknown";
  }

  function persist() {
    vscode.setState({ selectedAgentId, followedAgentId, filters: [...enabledFilters] });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return "not reported";
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(value);
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString() : "Not reported";
  }

  function metric(label, value, detail) {
    const card = element("div", "metric");
    card.append(
      element("span", "metric-label", label),
      element("strong", "metric-value", String(value)),
      element("span", "metric-detail", detail)
    );
    return card;
  }

  function renderOverview() {
    const focused = document.activeElement?.dataset?.boardFocus;
    roomNameEl.textContent = snapshot.room || "Not connected";
    roomMetaEl.textContent = snapshot.room && snapshot.connection !== "online"
      ? `Disconnected · last known roster: ${snapshot.memberCount} people and ${snapshot.agents.length} agents`
      : snapshot.room
      ? `${snapshot.mode === "hosted" ? "Hosted" : "BYO"} · ${snapshot.presentMemberCount}/${snapshot.memberCount} people present · ${snapshot.agents.length} attached agents`
      : "Open a room to inspect its agents.";
    const connectionLabel = snapshot.connection === "online"
      ? snapshot.status === "idle" ? "online" : snapshot.status.replaceAll("-", " ")
      : snapshot.connection;
    connectionEl.textContent = connectionLabel;
    connectionEl.className = `connection ${snapshot.connection} ${snapshot.status}`;
    workspaceStateEl.className = `workspace-state ${snapshot.workspace.state}`;
    workspaceStateLabelEl.textContent = snapshot.workspace.label;
    workspaceStateDetailEl.textContent = snapshot.workspace.detail;
    overviewUpdatedEl.textContent = `Updated ${formatTime(Date.now())}`;

    overviewMetricsEl.replaceChildren(
      metric("People", snapshot.connection === "online" ? `${snapshot.presentMemberCount}/${snapshot.memberCount}` : snapshot.memberCount, snapshot.connection === "online" ? "currently present" : "last known roster"),
      metric("Agents", snapshot.agents.length, `${snapshot.agents.filter((agent) => agent.statusGroup === "active").length} active`),
      metric("Goals", snapshot.activeGoals.length, "active room goals"),
      metric("Handoffs", snapshot.pendingHandoffCount, "open lifecycle items"),
      metric("Work", snapshot.actionCount, "durable actions"),
      metric("Context", snapshot.contextCount, "live shared items")
    );

    roomPulseEl.replaceChildren();
    if (snapshot.agents.length === 0) {
      roomPulseEl.appendChild(element("div", "empty-state", "No agents are attached to this room."));
      return;
    }
    for (const agent of snapshot.agents) {
      const pulse = element("article", `pulse team-card ${agent.statusGroup}`);
      pulse.setAttribute("role", "listitem");
      pulse.style.setProperty("--owner-color", `var(--ripieno-hue-${agent.ownerColor})`);
      pulse.setAttribute("aria-label", `${agent.label}, owned by ${agent.ownerName}, ${statusLabel(agent)}`);
      pulse.append(
        element("span", "pulse-dot"),
        element("strong", "pulse-label", agent.label),
        element("span", "pulse-owner", agent.ownerName),
        element("span", "pulse-status", statusLabel(agent))
      );
      const held = snapshot.board.claims.filter(c => c.agentId === agent.agentId);
      pulse.appendChild(element("p", "team-task", held[0]?.task || agent.currentTask));
      const files = [...new Set([...held.flatMap(c => c.paths), ...(agent.activity?.locationScope === "shared" && agent.activity.path ? [agent.activity.path] : [])])];
      pulse.appendChild(element("p", "team-files", files.length ? files.slice(0, 3).join(" · ") : "No shared files reported"));
      const warnings = snapshot.board.overlaps.filter(w => w.agentIds.includes(agent.agentId));
      if (warnings.length) pulse.appendChild(element("span", "attention-badge", `${warnings.length} possible overlap${warnings.length === 1 ? "" : "s"}`));
      if (agent.state === "waiting-approval") pulse.appendChild(element("span", "attention-badge", "Needs approval"));
      const inspect = element("button", "board-button", "Inspect agent");
      inspect.dataset.boardFocus = `agent:${agent.agentId}`;
      inspect.type = "button";
      inspect.addEventListener("click", () => {
        enabledFilters.add(agent.statusGroup);
        followedAgentId = undefined;
        selectedAgentId = agent.agentId;
        persist();
        renderFilters();
        renderAgents(true);
        detailEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      pulse.appendChild(inspect);
      roomPulseEl.appendChild(pulse);
    }
    restoreBoardFocus(focused);
  }

  function restoreBoardFocus(key) {
    if (!key) return;
    [...document.querySelectorAll("[data-board-focus]")].find(node => node.dataset.boardFocus === key)?.focus({ preventScroll: true });
  }

  function setOptions(select, items, placeholder) {
    const signature = JSON.stringify(items);
    if (select.dataset.options === signature) return;
    const selected = select.value;
    select.replaceChildren(new Option(placeholder, ""), ...items.map(([id, label]) => new Option(label, id)));
    if (items.some(([id]) => id === selected)) select.value = selected;
    select.dataset.options = signature;
  }

  function enteredPaths() {
    return [...new Set(claimPaths.value.split("\n").map(p => p.trim()).filter(Boolean))];
  }

  function renderPreflight() {
    const preflight = document.getElementById("claimPreflight");
    if (!snapshot?.board.canClaim) { preflight.textContent = ""; return; }
    const paths = enteredPaths().map(p => p.replace(/\\/g, "/").split("/").filter(p => p && p !== ".").join("/"));
    const task = claimTask.value.trim().toLowerCase().replace(/\s+/g, " ");
    const others = snapshot.board.claims.filter(c => c.ownerHandle !== snapshot.you?.handle &&
      (c.paths.some(p => paths.includes(p)) || task && c.task.toLowerCase().replace(/\s+/g, " ") === task));
    const editing = snapshot.agents.filter(a => a.ownerHandle !== snapshot.you?.handle &&
      a.activity?.phase === "editing" && a.activity.locationScope === "shared" && paths.includes(a.activity.path));
    const owners = [...new Set([...others.map(c => c.ownerHandle), ...editing.map(a => a.ownerHandle)])];
    preflight.textContent = owners.length ? `Possible overlap with ${owners.map(o => `@${o}`).join(", ")}. Review their work below and coordinate before editing. Claiming does not pause another agent.` : "";
  }

  function renderBoard() {
    const focused = document.activeElement?.dataset?.boardFocus;
    const board = snapshot.board;
    document.getElementById("claimCount").textContent = snapshot.connection === "online" ? `${board.claims.length} active claim${board.claims.length === 1 ? "" : "s"}` : "Claims unavailable";
    const attention = [];
    if (board.overlapCount) attention.push(`${board.overlapCount} possible overlap${board.overlapCount === 1 ? "" : "s"}`);
    if (board.pendingApprovalCount) attention.push(`${board.pendingApprovalCount} approval${board.pendingApprovalCount === 1 ? "" : "s"} waiting in the Room sidebar`);
    if (snapshot.pendingHandoffCount) attention.push(`${snapshot.pendingHandoffCount} open handoff${snapshot.pendingHandoffCount === 1 ? "" : "s"} in the Room sidebar`);
    const attentionEl = document.getElementById("boardAttention");
    const attentionText = attention.join(" · ");
    if (attentionEl.textContent !== attentionText) attentionEl.textContent = attentionText;
    const warningList = document.getElementById("overlapWarnings");
    warningList.replaceChildren();
    for (const warning of board.overlaps) {
      const card = element("article", "overlap-card");
      card.setAttribute("role", "listitem");
      card.append(element("strong", "", `${warning.kind === "file" ? "Shared file" : "Same task"}: ${warning.target}`),
        element("p", "", `${warning.owners.map(o => `@${o}`).join(" and ")} · ${warning.evidence === "activity" ? "live editing or proposed changes overlap" : "declared intentions overlap"}. Check before editing.`));
      for (const id of warning.agentIds) {
        const agent = snapshot.agents.find(a => a.agentId === id);
        if (!agent) continue;
        const inspect = element("button", "board-button", `View ${agent.label}`);
        inspect.dataset.boardFocus = `${warning.key}:${id}`;
        inspect.type = "button";
        inspect.addEventListener("click", () => { enabledFilters.add(agent.statusGroup); selectAgent(id, true); detailEl.scrollIntoView({ block: "nearest" }); });
        card.appendChild(inspect);
      }
      warningList.appendChild(card);
    }
    setOptions(claimAgent, snapshot.agents.filter(a => a.ownerHandle === snapshot.you?.handle).map(a => [a.agentId, a.label]), "I'll coordinate it myself");
    setOptions(claimGoal, snapshot.activeGoals.map(g => [g.id, g.text]), "No goal link");
    for (const control of claimForm.querySelectorAll("input, textarea, select, button")) control.disabled = !board.canClaim || Boolean(pendingClaimAction);
    if (!board.canClaim) {
      claimFeedback.textContent = snapshot.connection !== "online" ? "Reconnect to claim work. Live overlap cannot be checked while offline."
        : !board.supported ? "This relay needs an update to support work claims." : "Viewers can watch claims. A room member can claim work.";
      claimFeedback.dataset.unavailable = "true";
    } else if (claimFeedback.dataset.unavailable) {
      claimFeedback.textContent = "";
      delete claimFeedback.dataset.unavailable;
    }
    const list = document.getElementById("workClaims");
    list.replaceChildren();
    if (!board.claims.length) list.appendChild(element("p", "empty-state", snapshot.connection !== "online"
      ? "Current claims are unavailable until the room reconnects."
      : !board.supported ? "Update the relay to see and share work claims."
      : "No work is claimed. Tell the team what you intend to do before starting your agent."));
    for (const claim of board.claims) {
      const card = element("article", "claim-card");
      card.setAttribute("role", "listitem");
      const agent = snapshot.agents.find(a => a.agentId === claim.agentId);
      const goal = snapshot.activeGoals.find(g => g.id === claim.goalId);
      card.append(element("strong", "", claim.task), element("p", "claim-owner", `@${claim.ownerHandle}${agent ? ` · ${agent.label}` : claim.agentId ? " · agent detached" : " · coordinating without an agent"}`));
      if (goal) card.appendChild(element("p", "board-help", `Goal: ${goal.text}`));
      if (claim.paths.length) card.appendChild(element("p", "team-files", claim.paths.join(" · ")));
      card.appendChild(element("span", "board-help", "Intention only · renews while its editor is connected"));
      if (claim.ownerHandle === snapshot.you?.handle) {
        const release = element("button", "board-button", "Release work");
        release.dataset.boardFocus = `release:${claim.id}`;
        release.type = "button";
        release.disabled = !board.canClaim || Boolean(pendingClaimAction);
        release.addEventListener("click", () => {
          pendingClaimAction = "release";
          vscode.postMessage({ type: "claimRelease", claimId: claim.id });
          renderBoard();
        });
        card.appendChild(release);
      }
      list.appendChild(card);
    }
    renderPreflight();
    restoreBoardFocus(focused);
  }

  claimTask.addEventListener("input", renderPreflight);
  claimPaths.addEventListener("input", renderPreflight);
  claimGoal.addEventListener("change", () => {
    if (!claimTask.value.trim()) claimTask.value = snapshot.activeGoals.find(g => g.id === claimGoal.value)?.text.slice(0, 240) || "";
    renderPreflight();
  });
  claimForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!snapshot?.board.canClaim || pendingClaimAction) return;
    const paths = enteredPaths();
    if (paths.length > 8 || paths.some(p => p.length > 240)) { claimFeedback.textContent = "Choose up to eight paths, each at most 240 characters."; return; }
    if (paths.length && snapshot.workspace.state === "offline") { claimFeedback.textContent = "Host a shared workspace first, or leave the file list empty."; return; }
    pendingClaimAction = "create";
    submittedTask = claimTask.value;
    claimFeedback.textContent = "Waiting for the room to confirm…";
    vscode.postMessage({ type: "claimCreate", task: claimTask.value.trim(), paths,
      ...(claimAgent.value ? { agentId: claimAgent.value } : {}), ...(claimGoal.value ? { goalId: claimGoal.value } : {}) });
    renderBoard();
  });

  function statusLabel(agent) {
    const phase = agent.activity?.phase || agent.state;
    return phase ? phase.replaceAll("-", " ") : "not reported";
  }

  function renderFilters() {
    for (const button of filtersEl.querySelectorAll("[data-filter]")) {
      const enabled = enabledFilters.has(button.dataset.filter);
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("selected", enabled);
    }
  }

  filtersEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button || !isStatusGroup(button.dataset.filter)) return;
    if (enabledFilters.has(button.dataset.filter)) enabledFilters.delete(button.dataset.filter);
    else enabledFilters.add(button.dataset.filter);
    persist();
    renderFilters();
    renderAgents();
  });

  function visibleAgents() {
    return snapshot.agents.filter((agent) => enabledFilters.has(agent.statusGroup));
  }

  function renderAgents(focusSelected = false) {
    const focusedAgentId = railEl.contains(document.activeElement)
      ? document.activeElement?.dataset?.agentId
      : undefined;
    const previousScrollLeft = railEl.scrollLeft;
    const followed = snapshot.agents.find((agent) => agent.agentId === followedAgentId);
    if (followed && !enabledFilters.has(followed.statusGroup)) {
      enabledFilters.add(followed.statusGroup);
      announcementsEl.textContent = `${followed.label} is ${statusLabel(followed)}. The matching status filter was enabled to keep following this agent.`;
      renderFilters();
    }
    const visible = visibleAgents();
    if (followedAgentId && visible.some((agent) => agent.agentId === followedAgentId)) {
      selectedAgentId = followedAgentId;
    }
    if (!visible.some((agent) => agent.agentId === selectedAgentId)) selectedAgentId = visible[0]?.agentId;
    persist();
    railEl.replaceChildren();
    filterEmptyEl.hidden = visible.length > 0;
    detailEl.hidden = visible.length === 0;

    visible.forEach((agent, index) => {
      const selected = agent.agentId === selectedAgentId;
      const tab = element("button", `agent-tab ${agent.statusGroup}${selected ? " selected" : ""}`);
      tab.type = "button";
      tab.id = `agent-tab-${index}`;
      tab.dataset.agentId = agent.agentId;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("aria-controls", "agentDetail");
      tab.tabIndex = selected ? 0 : -1;
      tab.style.setProperty("--owner-color", `var(--ripieno-hue-${agent.ownerColor})`);
      tab.append(
        element("span", "agent-tab-dot"),
        element("strong", "agent-tab-label", agent.label),
        element("span", "agent-tab-owner", `Owner: ${agent.ownerName}`),
        element("span", "agent-tab-state", statusLabel(agent))
      );
      tab.addEventListener("click", () => selectAgent(agent.agentId, true));
      railEl.appendChild(tab);
    });

    const selected = visible.find((agent) => agent.agentId === selectedAgentId);
    if (selected) {
      const selectedIndex = visible.indexOf(selected);
      detailEl.setAttribute("aria-labelledby", `agent-tab-${selectedIndex}`);
      renderAgentDetail(selected);
    }
    railEl.scrollLeft = previousScrollLeft;
    const focusAgentId = focusSelected ? selectedAgentId : focusedAgentId;
    const focusTarget = [...railEl.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.dataset.agentId === focusAgentId);
    if (focusTarget) focusTarget.focus({ preventScroll: !focusSelected });
  }

  function selectAgent(agentId, focus) {
    selectedAgentId = agentId;
    if (followedAgentId && followedAgentId !== agentId) followedAgentId = undefined;
    persist();
    renderAgents(focus);
  }

  railEl.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...railEl.querySelectorAll('[role="tab"]')];
    if (tabs.length === 0) return;
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    selectAgent(tabs[next].dataset.agentId, true);
  });

  function detailSection(title, className) {
    const section = element("section", `detail-card ${className || ""}`.trim());
    section.appendChild(element("h3", "detail-card-title", title));
    return section;
  }

  function listOrEmpty(items, render, emptyText) {
    if (items.length === 0) return element("p", "detail-empty", emptyText);
    const list = element("ul", "detail-list");
    for (const item of items) list.appendChild(render(item));
    return list;
  }

  function renderAgentDetail(agent) {
    detailEl.replaceChildren();
    detailEl.style.setProperty("--owner-color", `var(--ripieno-hue-${agent.ownerColor})`);
    const header = element("header", "agent-detail-header");
    const identity = element("div", "agent-detail-identity");
    const title = element("h2", "agent-detail-title", agent.label);
    const owner = element("p", "agent-detail-owner", `Owned by ${agent.ownerName} (@${agent.ownerHandle})`);
    const exact = element("code", "exact-agent-id", agent.agentId);
    exact.title = "Relay-authoritative exact agent id";
    identity.append(title, owner, exact);
    const controls = element("div", "agent-detail-controls");
    const state = element("span", `state-badge ${agent.statusGroup}`, statusLabel(agent));
    const follow = element("button", "follow-button", followedAgentId === agent.agentId ? "Following agent" : "Follow agent");
    follow.type = "button";
    follow.setAttribute("aria-pressed", String(followedAgentId === agent.agentId));
    follow.title = "Keep this exact agent selected while its live status changes";
    follow.addEventListener("click", () => {
      followedAgentId = followedAgentId === agent.agentId ? undefined : agent.agentId;
      lastFollowActivity = agent.activity?.updatedAt;
      announcementsEl.textContent = followedAgentId ? `Following ${agent.label}.` : `Stopped following ${agent.label}.`;
      persist();
      renderAgentDetail(agent);
    });
    controls.append(state, follow);
    header.append(identity, controls);
    detailEl.appendChild(header);

    const grid = element("div", "detail-grid");
    const task = detailSection("Current task", "task-card");
    task.appendChild(element("p", "current-task", agent.currentTask));
    task.appendChild(element("p", "detail-meta", agent.activity?.updatedAt
      ? `${statusLabel(agent)} · updated ${formatTime(agent.activity.updatedAt)}`
      : `${statusLabel(agent)} · no rich activity timestamp reported`));
    if (agent.activity?.path) {
      const location = element(agent.locationOpenable ? "button" : "code", `active-location${agent.locationOpenable ? " location-link" : ""}`);
      if (agent.locationOpenable) {
        location.type = "button";
        location.title = agent.activity.locationScope === "shared"
          ? "Open this shared-workspace location"
          : "Open this owner-local location";
        location.addEventListener("click", () => {
          vscode.postMessage({ type: "openAgentLocation", agentId: agent.agentId });
        });
      } else {
        location.title = agent.activity.locationScope === "private"
          ? "This private-workspace location is visible but cannot be mapped on this machine"
          : "No shared workspace is currently available";
      }
      const range = agent.activity.line
        ? `:${agent.activity.line}${agent.activity.endLine > agent.activity.line ? `-${agent.activity.endLine}` : ""}`
        : "";
      location.textContent = `${agent.activity.path}${range}`;
      task.appendChild(location);
    }
    grid.appendChild(task);

    if (agent.proposal) {
      const proposal = detailSection("Proposed change", "proposal-card");
      const status = element("p", "proposal-status", "Temporary proposal · not applied");
      status.title = "Only an approved write followed by durable Work can confirm this change";
      proposal.append(status, element("code", "proposal-path", agent.proposal.path));
      const patch = element("pre", "proposal-patch", agent.proposal.patch);
      patch.tabIndex = 0;
      patch.setAttribute("aria-label", `Temporary proposed diff for ${agent.proposal.path}`);
      proposal.appendChild(patch);
      if (agent.proposalOpenable) {
        const open = element("button", "proposal-open", "Open proposed patch");
        open.type = "button";
        open.title = "Open a read-only diff document; this does not apply the proposal";
        open.addEventListener("click", () => {
          vscode.postMessage({ type: "openAgentProposal", agentId: agent.agentId });
        });
        proposal.appendChild(open);
      } else {
        proposal.appendChild(element(
          "p",
          "detail-note",
          "The shared workspace is offline, so this patch cannot be mapped to a current document."
        ));
      }
      proposal.appendChild(element(
        "p",
        "detail-note",
        "A streamed proposal never writes a file. Approved writes reconcile into durable Work below."
      ));
      grid.appendChild(proposal);
    }

    const intent = detailSection("Goals and handoffs", "intent-card");
    intent.appendChild(listOrEmpty(agent.handoffs, (handoff) => {
      const item = element("li", "handoff-item");
      item.append(
        element("strong", "", `${handoff.status}: ${handoff.task}`),
        element("span", "detail-meta", `${handoff.sourceAgentLabel} → ${handoff.targetAgentLabel || `@${handoff.targetHandle}`}`)
      );
      return item;
    }, "No handoff is associated with this exact agent."));
    intent.appendChild(listOrEmpty(agent.activeGoals, (goal) => {
      const item = element("li", "goal-item", goal.text);
      item.title = `Room goal owned by @${goal.ownerHandle}`;
      return item;
    }, "No active room goals."));
    grid.appendChild(intent);

    const workingSet = detailSection("Working set", "working-set-card");
    workingSet.appendChild(listOrEmpty(agent.workingSet, (target) => {
      const item = element("li");
      item.appendChild(element("code", "work-target", target));
      return item;
    }, "No live location or recent work targets reported."));
    workingSet.appendChild(element("p", "detail-note", "Working set combines the current shared location with recent durable Work targets; it is not a keystroke cursor."));
    grid.appendChild(workingSet);

    const actions = detailSection("Recent actions", "actions-card");
    actions.appendChild(listOrEmpty(agent.recentActions, (action) => {
      const item = element("li", `action-item ${action.ok ? "ok" : "failed"}`);
      item.append(
        element("span", "action-mark", action.ok ? "✓" : "!"),
        element("span", "", `${action.verb} ${action.target}${action.detail ? ` · ${action.detail}` : ""}`),
        element("time", "detail-meta", formatTime(action.ts))
      );
      return item;
    }, "No durable Work entries for this agent."));
    grid.appendChild(actions);

    const usage = detailSection("Usage", "usage-card");
    if (!agent.usage) usage.appendChild(element("p", "detail-empty", "No usage has been reported for this agent."));
    else if (agent.usage.unreported) usage.appendChild(element("p", "detail-empty", `${agent.usage.provider} does not report usage.`));
    else {
      const table = element("dl", "usage-list");
      for (const [label, value] of [
        ["Provider", agent.usage.provider],
        ["Turns", formatNumber(agent.usage.turns)],
        ["Input tokens", formatNumber(agent.usage.inputTokens)],
        ["Output tokens", formatNumber(agent.usage.outputTokens)],
        ["Cache reads", formatNumber(agent.usage.cacheReadTokens)],
        ["Reported cost", Number.isFinite(agent.usage.costUsd) ? `$${agent.usage.costUsd.toFixed(4)}` : "Not reported"],
      ]) table.append(element("dt", "", label), element("dd", "", String(value)));
      usage.appendChild(table);
    }
    grid.appendChild(usage);

    const permissions = detailSection("Capability and permissions", "permissions-card");
    permissions.appendChild(element("p", "shared-capability", `Shared capability: ${agent.capability || "not reported"}`));
    if (agent.privateLocal) {
      const local = element("div", "private-local");
      local.append(element("span", "private-badge", "Private to this editor"), element("strong", "", "Owner-local configuration"));
      const list = element("dl", "private-list");
      for (const [label, value] of [
        ["Provider", agent.privateLocal.provider],
        ["Model", agent.privateLocal.model],
        ["Project", agent.privateLocal.folder],
        ["Permissions", agent.privateLocal.permissions],
        ["Response mode", agent.privateLocal.responseMode],
      ]) if (value) list.append(element("dt", "", label), element("dd", "", value));
      local.append(list, element("p", "detail-note", "This configuration stays on your machine. Provider reasoning, diagnostics, raw logs, tool JSON and credentials are not included."));
      permissions.appendChild(local);
    } else {
      permissions.appendChild(element("p", "detail-note", "The owner's provider settings and permissions are not shared. Only the relay-visible capability appears here."));
    }
    grid.appendChild(permissions);
    detailEl.appendChild(grid);
  }

  const brainSearch = document.getElementById("brainSearch");
  const brainFilter = document.getElementById("brainFilter");
  brainSearch?.addEventListener("input", () => renderBrain());
  brainFilter?.addEventListener("change", () => renderBrain());
  function sharedAction(label, action, id, disabled = false) {
    const button = element("button", "context-action", label); button.type = "button"; button.disabled = disabled; button.dataset.brainKey = `${action}:${id || "new"}`;
    button.addEventListener("click", () => vscode.postMessage({ type: "collaborationAction", action, ...(id ? { id } : {}) })); return button;
  }
  function renderBrain() {
    const list = document.getElementById("brainList"); if (!list) return;
    const focusedKey = document.activeElement?.dataset?.brainKey;
    const canAct = snapshot.collaborationSupported !== false && snapshot.connection === "online" && ["owner", "member"].includes(snapshot.you?.role);
    const actions = document.getElementById("brainActions"); actions.replaceChildren();
    for (const [label, action] of [["New plan", "plan"], ["New task", "task"], ["Remember", "memory"], ["Continue in Amoeba ↗", "export"]]) actions.appendChild(sharedAction(label, action, undefined, action === "export" ? !snapshot.room : !canAct));
    list.replaceChildren(); const search = (brainSearch.value || "").toLowerCase(); const filter = brainFilter.value;
    const records = (snapshot.context || []).filter(item => {
      const retired = ["archived", "superseded"].includes(item.status);
      if (filter === "retired" ? !retired : retired) return false;
      if (!["all", "retired"].includes(filter) && (filter === "proposed" ? item.status !== "proposed" : (item.collaboration?.type || "memory") !== filter)) return false;
      return [item.title, item.body, item.authorHandle, item.collaboration?.assigneeHandle, ...item.tags].join(" ").toLowerCase().includes(search);
    });
    for (const item of records) {
      const r = item.collaboration; const card = element("article", "brain-card");
      card.append(element("span", "eyebrow", `${r?.type || item.kind} · ${item.status}${r && ["task", "plan"].includes(r.type) ? ` · ${r.progress}` : ""}`), element("h3", "", item.title), element("p", "brain-body", item.body));
      card.appendChild(element("p", "detail-meta", `By @${item.authorHandle} · v${item.version}${r?.assigneeHandle ? ` · Assigned to @${r.assigneeHandle}` : ""}`));
      if (r?.replyTo) card.appendChild(element("p", "detail-meta", `Reply to: ${(snapshot.context || []).find(c => c.id === r.replyTo)?.title || r.replyTo}`));
      if (r?.anchor) card.appendChild(element("p", "detail-note", r.anchor.workspaceHost === snapshot.workspace.hostHandle ? "Anchor content is verified when opened." : "Anchor host must match before opening; content will be verified."));
      if (r?.goalId) card.appendChild(element("p", "detail-meta", `Goal: ${snapshot.goals.find(g => g.id === r.goalId)?.text || r.goalId}`));
      if (r?.claimId) { const claim = snapshot.board.claims.find(c => c.id === r.claimId); card.appendChild(element("p", "detail-meta", claim ? `Work claim: ${claim.task}` : "Linked work claim expired or was released; this record remains saved.")); }
      if (r?.steps?.length) { const steps = element("ol", "plan-steps"); for (const step of r.steps) steps.appendChild(element("li", "", `${step.status === "done" ? "✓" : step.status === "doing" ? "●" : "○"} ${step.text}${step.assigneeHandle ? ` (@${step.assigneeHandle})` : ""}${step.dependsOn.length ? ` — after ${step.dependsOn.join(", ")}` : ""}`)); card.appendChild(steps); }
      const buttons = element("div", "brain-card-actions");
      if (r?.anchor) buttons.appendChild(sharedAction(`${r.anchor.path}:${r.anchor.startLine}–${r.anchor.endLine}`, "open", item.id));
      if (r) buttons.appendChild(sharedAction("Manage / reply", "edit", item.id, !canAct));
      if (canAct && item.status === "proposed") { const accept = element("button", "context-action", "Accept memory"); accept.dataset.brainKey = `accept:${item.id}`; accept.addEventListener("click", () => vscode.postMessage({type:"contextStatus",id:item.id,expectedVersion:item.version,status:"accepted"}));buttons.appendChild(accept); }
      if (canAct && ["accepted", "proposed"].includes(item.status) && (item.authorHandle === snapshot.you?.handle || snapshot.you?.role === "owner")) { const archive = element("button", "context-action", "Archive"); archive.dataset.brainKey = `archive:${item.id}`; archive.addEventListener("click", () => vscode.postMessage({type:"contextStatus",id:item.id,expectedVersion:item.version,status:"archived"}));buttons.appendChild(archive); }
      card.appendChild(buttons); list.appendChild(card);
    }
    if (!records.length) list.appendChild(element("p", "detail-note", "No matching records. Create a plan or memory here, or select shared code and use Add Shared Code Comment in the editor menu."));
    const recovery = document.getElementById("handoffRecovery"); recovery.replaceChildren();
    for (const h of (snapshot.recoveryHandoffs || []).filter(h => ["pending", "assigned", "claimed", "started", "failed", "outcomeUnknown", "expired"].includes(h.status))) {
      const card = element("article", "brain-card"); card.append(element("strong", "", `${h.status}: ${h.task}`), element("p", "detail-meta", `@${h.sourceOwnerHandle} → @${h.targetHandle}`));
      if (h.status === "outcomeUnknown") card.appendChild(element("p", "detail-note", "Execution may already have happened. Review shared files and Work evidence before explicitly retrying; retry creates a new attempt."));
      if (h.outcomeDetail) card.appendChild(element("p", "brain-body", h.outcomeDetail));
      const recipient = h.targetHandle === snapshot.you?.handle;
      if (recipient && canAct && ["pending", "failed", "outcomeUnknown"].includes(h.status)) {
        const button = element("button", "context-action", h.status === "pending" ? "Accept with my agent…" : "Review and retry with my agent…");
        button.dataset.brainKey = `handoff:${h.id}`;
        button.addEventListener("click", () => vscode.postMessage({type:"handoffAction",action:h.status === "pending" ? "accept" : "retry",id:h.id,expectedVersion:h.version})); card.appendChild(button);
      }
      recovery.appendChild(card);
    }
    if (!recovery.children.length) recovery.appendChild(element("p", "detail-note", "No handoff needs recovery. Durable assignments and outcomes are restored by the relay on reconnect."));
    if (focusedKey) {
      const replacement = [...document.querySelectorAll("[data-brain-key]")].find(node => node.dataset.brainKey === focusedKey);
      if (replacement && !replacement.disabled) replacement.focus({preventScroll:true});
      else brainSearch.focus({preventScroll:true});
    }
  }

  function applySnapshot(next) {
    const followed = next.agents.find((agent) => agent.agentId === followedAgentId);
    if (followedAgentId && !followed) {
      announcementsEl.textContent = "The followed agent detached from the room.";
      followedAgentId = undefined;
      lastFollowActivity = undefined;
    } else if (followed && followed.activity?.updatedAt && followed.activity.updatedAt !== lastFollowActivity) {
      lastFollowActivity = followed.activity.updatedAt;
      announcementsEl.textContent = `${followed.label} is ${statusLabel(followed)}: ${followed.currentTask}`;
    }
    snapshot = next;
    renderOverview();
    renderBoard();
    renderBrain();
    renderFilters();
    renderAgents();
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "claimResult") {
      if (message.ok && pendingClaimAction === "create" && submittedTask === claimTask.value) { claimTask.value = ""; claimPaths.value = ""; claimGoal.value = ""; }
      pendingClaimAction = undefined;
      claimFeedback.textContent = message.message;
      if (snapshot) renderBoard();
      return;
    }
    if (!message || message.type !== "panelSnapshot" || !Array.isArray(message.agents)) return;
    applySnapshot(message);
  });

  vscode.postMessage({ type: "panelReady" });
})();
