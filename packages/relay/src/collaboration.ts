import type { CollaborationRecord, Goal, RosterEntry, WorkClaim } from "@ripieno/protocol";

/** Runtime validation belongs at the relay, including graph and identity constraints. */
export function validateCollaboration(value: CollaborationRecord, roster: RosterEntry[], goals: Goal[], claims: WorkClaim[], previous?: CollaborationRecord): string | undefined {
  if (!value || typeof value !== "object" || !["comment", "task", "plan", "memory"].includes(value.type) || !["todo", "doing", "done"].includes(value.progress)) return "Invalid collaboration record.";
  if (Object.keys(value).some(k => !["replyTo", "type", "anchor", "assigneeHandle", "goalId", "claimId", "progress", "steps"].includes(k))) return "Unknown collaboration field.";
  if (value.replyTo !== undefined && (typeof value.replyTo !== "string" || !/^context_[a-f0-9-]{36}$/.test(value.replyTo))) return "Invalid discussion parent.";
  if (value.assigneeHandle !== undefined && !roster.some(m => m.handle === value.assigneeHandle && m.role !== "viewer")) return "Choose a room member as the human assignee.";
  if (value.type === "task" && !value.assigneeHandle) return "A task requires a human assignee.";
  if (value.goalId !== undefined && !goals.some(g => g.id === value.goalId)) return "Linked goal no longer exists.";
  if (value.claimId !== undefined && !(previous?.claimId === value.claimId && previous.goalId === value.goalId && previous.assigneeHandle === value.assigneeHandle) && !claims.some(c => c.id === value.claimId && c.expiresAt > Date.now() && (!value.goalId || c.goalId === value.goalId) && (!value.assigneeHandle || c.ownerHandle === value.assigneeHandle))) return "Choose a live claim matching the linked goal.";
  const a = value.anchor;
  if (a && (typeof a.path !== "string" || a.path.length > 1024 || !a.path || /(^\/|\\|[\x00-\x1f]|^[a-zA-Z]:)/.test(a.path) || a.path.split("/").some(p => !p || p === "." || p === "..") || typeof a.workspaceHost !== "string" || !roster.some(m => m.handle === a.workspaceHost) || !Number.isSafeInteger(a.startLine) || !Number.isSafeInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine || a.endLine > 10_000_000 || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256) || Object.keys(a).some(k => !["path", "workspaceHost", "startLine", "endLine", "sha256"].includes(k)))) return "Invalid shared code anchor.";
  if (value.type === "comment" && !a) return "A code comment requires an anchor.";
  if (!Array.isArray(value.steps) || value.steps.length > 40 || (value.type !== "plan" && value.steps.length)) return "Only plans may contain up to 40 steps.";
  const ids = new Set<string>();
  for (const s of value.steps) {
    if (!s || typeof s.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || ids.has(s.id) || typeof s.text !== "string" || !s.text.trim() || s.text.length > 500 || !["todo", "doing", "done"].includes(s.status) || !Array.isArray(s.dependsOn) || s.dependsOn.length > 40 || Object.keys(s).some(k => !["id", "text", "status", "dependsOn", "assigneeHandle"].includes(k))) return "Invalid or duplicate plan step.";
    if (s.assigneeHandle !== undefined && !roster.some(m => m.handle === s.assigneeHandle && m.role !== "viewer")) return "Choose a human room member for each step owner.";
    ids.add(s.id);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  function cycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of value.steps.find(s => s.id === id)!.dependsOn) if (typeof dep !== "string" || !ids.has(dep) || cycle(dep)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  if (value.steps.some(s => cycle(s.id))) return "Plan dependencies must exist and cannot form a cycle.";
  if (value.steps.some(s => s.status !== "todo" && s.dependsOn.some(id => value.steps.find(d => d.id === id)!.status !== "done"))) return "Finish prerequisite steps before starting dependent work.";
  if (value.type === "plan") {
    if (!value.steps.length) return "A plan needs at least one step.";
    const derived = value.steps.every(s => s.status === "done") ? "done" : value.steps.some(s => s.status !== "todo") ? "doing" : "todo";
    if (value.progress !== derived) return "Plan progress must match its step statuses.";
  }
  return undefined;
}

/** Assignees may advance their own progress, without changing ownership, content or dependencies. */
export function canAdvanceAssignedWork(before: CollaborationRecord | undefined, after: CollaborationRecord | undefined, handle: string): boolean {
  if (!before || !after) return false;
  const editable = before.assigneeHandle === handle;
  const ownStep = before.steps.some(s => s.assigneeHandle === handle);
  if (!editable && !ownStep) return false;
  const scrub = (r: CollaborationRecord) => ({ ...r, progress: undefined, steps:r.steps.map(s => ({...s, status: editable || s.assigneeHandle === handle ? undefined : s.status})) });
  return JSON.stringify(scrub(before)) === JSON.stringify(scrub(after));
}
