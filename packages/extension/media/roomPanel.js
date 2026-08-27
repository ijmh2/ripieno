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
    roomNameEl.textContent = snapshot.room || "Not connected";
    roomMetaEl.textContent = snapshot.room
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
      metric("People", `${snapshot.presentMemberCount}/${snapshot.memberCount}`, "currently present"),
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
      const pulse = element("button", `pulse ${agent.statusGroup}`);
      pulse.type = "button";
      pulse.setAttribute("role", "listitem");
      pulse.style.setProperty("--owner-color", `var(--ripieno-hue-${agent.ownerColor})`);
      pulse.setAttribute("aria-label", `${agent.label}, owned by ${agent.ownerName}, ${statusLabel(agent)}`);
      pulse.append(
        element("span", "pulse-dot"),
        element("strong", "pulse-label", agent.label),
        element("span", "pulse-owner", agent.ownerName),
        element("span", "pulse-status", statusLabel(agent))
      );
      pulse.addEventListener("click", () => {
        enabledFilters.add(agent.statusGroup);
        selectedAgentId = agent.agentId;
        persist();
        renderFilters();
        renderAgents(true);
      });
      roomPulseEl.appendChild(pulse);
    }
  }

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
    renderFilters();
    renderAgents();
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "panelSnapshot" || !Array.isArray(message.agents)) return;
    applySnapshot(message);
  });

  vscode.postMessage({ type: "panelReady" });
})();
