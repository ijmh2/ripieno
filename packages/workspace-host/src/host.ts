/**
 * The room's shared workspace, as a process rather than a laptop.
 *
 * Until now "the room's workspace" meant one member's machine: close VS Code and
 * the room's codebase vanished for everyone, mid-turn. This joins the room under
 * the reserved `workspace` handle, claims the workspace, and answers exactly the
 * same remote tool requests an editor answers.
 *
 * It needs no new routing. The room already asks "who is hosting?" through one
 * indirection — `resolveTarget` maps the `room` target to whichever handle holds
 * the claim — so from the agents' side nothing about this is new.
 */

import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { RemoteToolRequestMsg, ServerMsg } from "@mpa/protocol";
import { WORKSPACE_HANDLE } from "@mpa/protocol";
import { RelayClient, type ConnectionState } from "@mpa/relay-client";
import { WorkspaceCore, type Requester } from "@mpa/workspace-core";
import { ContainerGate, type CommandPolicy } from "./gate.js";
import { GitWorkspace, type RepoBinding } from "./git.js";

export interface WorkspaceHostOptions {
  relayUrl: string;
  room: string;
  root: string;
  keyDir: string;
  token?: string;
  workspaceToken: string;
  repo?: RepoBinding;
  policy: CommandPolicy;
  log?: (...parts: string[]) => void;
  /** The relay refused this connection for good. Tests override; production exits. */
  onEvicted?: (reason: string) => void;
}

export class WorkspaceHost {
  private readonly relay: RelayClient;
  private readonly git: GitWorkspace;
  private readonly core: WorkspaceCore;
  /** Paths written since the last flush, coalesced so a burst is one message. */
  private pendingChanges = new Set<string>();
  private changeTimer: NodeJS.Timeout | undefined;
  private ready = false;
  /**
   * The checkout as it really is on disk, resolved once it exists.
   *
   * Everything that turns an absolute path back into a repo-relative one has to
   * agree with what `resolveSafePath` returns, or commits are attempted against
   * paths git has never heard of.
   */
  private rootPath: string;

  constructor(private readonly opts: WorkspaceHostOptions) {
    const log = opts.log ?? (() => {});
    this.rootPath = opts.root;

    this.git = new GitWorkspace({
      root: opts.root,
      keyDir: opts.keyDir,
      repo: opts.repo,
      announce: (message) => this.say(message),
    });

    this.core = new WorkspaceCore({
      resolveRoot: () => ({ ok: true, abs: this.rootPath }),
      unattended: true,
      gate: new ContainerGate({
        policy: opts.policy,
        commit: (p) => {
          const rel = this.relative(p.abs);
          return this.git.commit(rel, p.requester, `${p.existed ? "Update" : "Add"} ${rel}`);
        },
        onChanged: (abs) => this.noteChanged(this.relative(abs)),
        // The repository owns its own concurrency; the write belongs inside it.
        serialise: (fn) => this.git.exclusive(fn),
      }),
    });

    this.relay = new RelayClient({
      url: opts.relayUrl,
      room: opts.room,
      // Identity is assigned by the relay, which refuses this handle to anyone
      // without the workspace token. Sent for completeness, never trusted.
      member: { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" },
      role: "workspace",
      token: opts.token,
      workspaceToken: opts.workspaceToken,
      onMessage: (msg) => this.onMessage(msg),
      onStateChange: (state) => this.onStateChange(state, log),
      // A 4003 or 4000 stops RelayClient reconnecting for good. Staying alive
      // after that leaves the room permanently without a workspace while the
      // platform's healthcheck still reports 200, so nothing ever restarts us.
      // Exit non-zero and let the platform do its job.
      onEvicted: (reason) => {
        log("evicted:", reason);
        this.opts.onEvicted?.(reason);
      },
    });
  }

  async start(): Promise<void> {
    const clone = await this.git.ensureClone();
    this.opts.log?.(clone.message);
    this.ready = clone.ok;
    // Only now does the directory certainly exist.
    this.rootPath = await realpath(this.opts.root).catch(() => this.opts.root);
    this.relay.connect();
    if (!clone.ok) {
      // Connect anyway: the room is the only place a member can be told what
      // went wrong, and a container that exits silently looks like a crash.
      this.say(clone.message);
    }
  }

  async stop(): Promise<void> {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    await this.git.flush();
    this.relay.dispose();
  }

  /** The public deploy key, so a member can authorise this room's repository. */
  deployKey(): Promise<string> {
    return this.git.ensureDeployKey();
  }

  private onStateChange(state: ConnectionState, log: (...parts: string[]) => void): void {
    log("relay:", state);
  }

  private onMessage(msg: ServerMsg): void {
    // Claim on the room's confirmation, not on the socket opening. "online"
    // fires inside the socket's open handler — before the join has been sent —
    // so claiming there raced ahead of joining and the relay rightly refused it.
    // `joined` also arrives again after every reconnect, which is exactly when
    // the claim needs re-asserting: a relay restart drops it with the
    // connection, and a workspace nobody is hosting is the failure this service
    // exists to prevent.
    if (msg.t === "joined") this.relay.send({ t: "claimWorkspace", claim: true });
    if (msg.t === "remoteToolRequest") void this.serve(msg);
  }

  /**
   * An agent asking to act on the shared workspace.
   *
   * The same core the editor uses, so the result an agent gets is identical
   * whether the room is hosted on a container or on somebody's laptop.
   */
  private async serve(msg: RemoteToolRequestMsg): Promise<void> {
    if (!this.ready) {
      this.relay.send({
        t: "remoteToolResult",
        requestId: msg.requestId,
        requesterAgentId: msg.requesterAgentId,
        content: "The shared workspace is not available: its repository could not be checked out.",
        isError: true,
      });
      return;
    }

    const requester: Requester = { label: msg.requesterLabel, handle: msg.requesterHandle };
    const result = await this.core.execute(msg.name, msg.input, () => {}, requester);
    this.relay.send({
      t: "remoteToolResult",
      requestId: msg.requestId,
      requesterAgentId: msg.requesterAgentId,
      content: result?.content ?? `This workspace cannot run "${msg.name}".`,
      isError: result ? result.isError : true,
    });
  }

  /**
   * Tell the room a path changed.
   *
   * This is what keeps every member's open tab honest: the same broadcast that
   * carries provenance also drives cache invalidation, so a file edited by
   * somebody else's agent refreshes rather than quietly going stale.
   */
  private noteChanged(relPath: string): void {
    this.pendingChanges.add(relPath);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      const paths = [...this.pendingChanges];
      this.pendingChanges.clear();
      this.changeTimer = undefined;
      if (paths.length > 0) this.relay.send({ t: "workspaceChanged", paths });
    }, 250);
    this.changeTimer.unref();
  }

  private say(text: string): void {
    this.relay.send({ t: "say", text });
  }

  private relative(abs: string): string {
    return path.relative(this.rootPath, abs) || path.basename(abs);
  }
}


