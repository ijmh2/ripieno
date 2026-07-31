// The Rooms & Agents tree: see who is in the room, which agents belong to whom,
// and drag your own agents in and out.
//
// Drag is confined to the tree. VS Code supports tree-to-tree drops properly
// through TreeDragAndDropController; dragging into a webview is not a supported
// path and would be fragile. Every drag action also has a command equivalent,
// so nothing here is drag-only.

import * as vscode from "vscode";
import type { AgentUsage, AttachedAgent, RoomMode, RosterEntry } from "@mpa/protocol";
import type { AgentState } from "./agentHost";

const MIME = "application/vnd.code.tree.mpa.rooms";

/** One of this member's agents, as the tree knows it. */
export interface MyAgent {
  id: string;
  label: string;
  state: AgentState;
  /** Project this agent works in, when it differs from the editor's workspace. */
  folder?: string;
  /** Model it runs on, when not the Claude Code default. */
  model?: string;
  /** Answers messages addressed to nobody in particular; the others wait to be named. */
  primary?: boolean;
  /** Whether it can touch files, or only talk. Shown, never implied. */
  capability?: "workspace" | "conversation";
  /** Which provider runs it — claude-code, grok, kimi, ollama… */
  provider?: string;
}

type Node =
  | { kind: "room"; code: string; mode: RoomMode; connected: boolean }
  | { kind: "member"; entry: RosterEntry; isYou: boolean }
  | { kind: "roomAgent"; agent: AttachedAgent }
  | { kind: "myAgent"; agent: MyAgent }
  | { kind: "hint"; text: string; command?: string };

export interface RoomsTreeHandlers {
  attachAgent(id: string): void;
  detachAgent(id: string): void;
  addAgent(): void;
  joinRoom(): void;
}

export class RoomsTreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>
{
  static readonly viewId = "mpa.rooms";

  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];

  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private room: string | undefined;
  private mode: RoomMode = "byo";
  private connected = false;
  private roster: RosterEntry[] = [];
  private myAgents: MyAgent[] = [];
  private myHandle: string | undefined;
  /** Whose machine is the room's shared workspace, if anyone has offered one. */
  private host: string | undefined;

  constructor(private readonly handlers: RoomsTreeHandlers) {}

  setRoom(room: string | undefined, mode: RoomMode, myHandle?: string): void {
    this.room = room;
    this.mode = mode;
    this.myHandle = myHandle ?? this.myHandle;
    this.refresh();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.refresh();
  }

  setRoster(roster: RosterEntry[], workspaceHost?: string): void {
    this.roster = roster;
    this.host = workspaceHost;
    this.refresh();
  }

  /** Running spend per agent, so the tree can say what each one has cost. */
  setUsage(usage: AgentUsage[]): void {
    this.usage = new Map(usage.map((u) => [u.agentId, u]));
    this.changed.fire(undefined);
  }
  private usage = new Map<string, AgentUsage>();

  setMyAgents(agents: MyAgent[]): void {
    this.myAgents = agents;
    this.refresh();
  }

  private refresh(): void {
    this.changed.fire(undefined);
  }

  /**
   * Match a roster agent to one of ours. The relay namespaces ids by owner
   * (`handle::localId`) so two members' agents cannot collide, so a local id is
   * a suffix rather than the whole thing.
   */
  private findMine(rosterId: string, owner: string): MyAgent | undefined {
    if (owner !== this.myHandle) return undefined;
    return this.myAgents.find(
      (a) => rosterId === `${this.myHandle}::${a.id}` || rosterId === a.id
    );
  }

  /* ---------------------------------------------------------------- */
  /* Tree                                                              */
  /* ---------------------------------------------------------------- */

  getChildren(node?: Node): Node[] {
    if (!node) {
      const roots: Node[] = [];
      roots.push(
        this.room
          ? { kind: "room", code: this.room, mode: this.mode, connected: this.connected }
          : { kind: "hint", text: "Not in a room — click to join", command: "mpa.joinRoom" }
      );
      // Detached agents live outside the room, ready to be dragged in.
      for (const agent of this.myAgents.filter((a) => a.state === "detached")) {
        roots.push({ kind: "myAgent", agent });
      }
      roots.push({ kind: "hint", text: "Add another agent…", command: "mpa.addAgent" });
      return roots;
    }

    if (node.kind === "room") {
      if (this.roster.length === 0) {
        return [{ kind: "hint", text: "No members yet" }];
      }
      return this.roster.map((entry) => ({
        kind: "member" as const,
        entry,
        isYou: entry.handle === this.myHandle,
      }));
    }

    if (node.kind === "member") {
      // A member's agents hang beneath them, so ownership is visible at a glance
      // even when several people each run more than one.
      return node.entry.agents.map((agent) => ({ kind: "roomAgent" as const, agent }));
    }

    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "room": {
        const item = new vscode.TreeItem(node.code, vscode.TreeItemCollapsibleState.Expanded);
        // The same product has very different capability per driver, so the room
        // says which one it is rather than leaving members to guess.
        item.description = `${node.mode === "hosted" ? "hosted agent" : "BYO"}${
          node.connected ? "" : " — offline"
        }`;
        item.iconPath = new vscode.ThemeIcon(node.connected ? "broadcast" : "debug-disconnect");
        item.contextValue = "mpaRoom";
        item.tooltip = new vscode.MarkdownString(
          node.mode === "hosted"
            ? "**Hosted** — one shared org agent runs this room. Members may still attach their own."
            : "**BYO** — every agent in this room belongs to a member."
        );
        return item;
      }

      case "member": {
        const { entry, isYou } = node;
        const item = new vscode.TreeItem(
          entry.displayName,
          entry.agents.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None
        );
        const bits = [`@${entry.handle}`];
        if (isYou) bits.push("you");
        if (!entry.present) bits.push("away");
        // Hosting is worth showing on the member, not buried in a tooltip:
        // it is the machine other people's agents are acting on.
        if (this.host === entry.handle) bits.push("hosts the workspace");
        item.description = bits.join(" · ");
        item.iconPath = new vscode.ThemeIcon(entry.present ? "account" : "circle-outline");
        item.contextValue = "mpaMember";
        return item;
      }

      case "roomAgent": {
        const mine = this.findMine(node.agent.id, node.agent.owner);
        const item = new vscode.TreeItem(node.agent.label);
        // Naming the folder matters once agents can work in different projects:
        // otherwise two identically-named agents look interchangeable.
        const suffix = mine ? detailSuffix(mine) : "";
        item.description = `${mine ? describeAgent(mine.state) : "attached"}${suffix}${describeUsage(
          this.usage.get(node.agent.id)
        )}`;
        item.iconPath = new vscode.ThemeIcon(
          mine?.state === "thinking" ? "loading~spin" : "robot"
        );
        // Only your own agents are yours to stop.
        item.contextValue = mine ? "mpaAgentAttached" : "mpaForeignAgent";
        item.id = `attached:${node.agent.id}`;
        return item;
      }

      case "myAgent": {
        const item = new vscode.TreeItem(node.agent.label);
        item.description = `${describeAgent(node.agent.state)}${detailSuffix(node.agent)}`;
        item.iconPath = new vscode.ThemeIcon("robot");
        item.contextValue = "mpaAgentDetached";
        item.id = `detached:${node.agent.id}`;
        item.tooltip = "Drag onto the room to attach it, or use the attach action.";
        return item;
      }

      case "hint": {
        const item = new vscode.TreeItem(node.text);
        if (node.command) {
          item.command = { command: node.command, title: node.text };
          item.iconPath = new vscode.ThemeIcon("add");
        }
        return item;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Drag and drop                                                     */
  /* ---------------------------------------------------------------- */

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const ids = source
      .filter((n): n is Extract<Node, { kind: "myAgent" | "roomAgent" }> =>
        n.kind === "myAgent" || n.kind === "roomAgent"
      )
      .map((n) => (n.kind === "myAgent" ? n.agent.id : n.agent.id))
      // Only agents this member owns can be dragged; someone else's is theirs.
      .filter((id) => this.myAgents.some((a) => a.id === id));
    if (ids.length > 0) {
      data.set(MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
    }
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const raw = data.get(MIME)?.value;
    if (typeof raw !== "string") return;

    let ids: string[];
    try {
      ids = JSON.parse(raw) as string[];
    } catch {
      return;
    }

    // Dropping onto the room (or anyone in it) attaches; dropping into the empty
    // space below detaches, which makes drag-out the natural inverse.
    const attaching = target?.kind === "room" || target?.kind === "member" || target?.kind === "roomAgent";
    for (const id of ids) {
      if (attaching) {
        this.handlers.attachAgent(id);
      } else if (!target) {
        this.handlers.detachAgent(id);
      }
    }
  }
}

/** Model and project, when they differ from the defaults — otherwise noise. */
function detailSuffix(agent: MyAgent): string {
  // "only when named" is worth surfacing: otherwise an agent that stays silent
  // by design looks broken. So is "no file access": otherwise somebody asks a
  // chat-only agent to fix a file and gets a confident answer and no change.
  const role = agent.primary ? undefined : "only when named";
  const reach = agent.capability === "conversation" ? "no file access" : undefined;
  const provider = agent.provider && agent.provider !== "claude-code" ? agent.provider : undefined;
  return [provider, agent.model, agent.folder, reach, role]
    .filter(Boolean)
    .map((bit) => ` · ${bit}`)
    .join("");
}

function describeAgent(state: AgentState): string {
  switch (state) {
    case "detached":
      return "detached — drag into the room";
    case "attaching":
      return "attaching…";
    case "thinking":
      return "thinking…";
    default:
      return "watching the room";
  }
}

/**
 * What an agent has cost, in a form that fits beside its name.
 *
 * Says nothing at all when the provider reports nothing. A "$0.00" against a
 * wrapped CLI would be the most confident number in the tree and the least true
 * one — and the cheapest-looking agent is exactly the one people would then
 * reach for.
 */
function describeUsage(usage: AgentUsage | undefined): string {
  if (!usage || usage.turns === 0) return "";
  const bits: string[] = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
  if (usage.costUsd !== undefined) {
    bits.push(`$${usage.costUsd.toFixed(2)}`);
  } else if (usage.outputTokens !== undefined) {
    // Tokens without a price: an OpenAI-compatible endpoint leaves pricing to
    // whoever is paying, and inventing a figure would mean shipping a price list.
    const total = (usage.inputTokens ?? 0) + usage.outputTokens;
    bits.push(`${Math.round(total / 1000)}k tokens`);
  } else if (usage.unreported) {
    bits.push("cost not reported");
  }
  return ` · ${bits.join(" · ")}`;
}
