/**
 * How a container answers "may I?".
 *
 * An editor asks the member: it shows a diff, waits for a click, and applies the
 * change through the undo stack. A container has nobody to ask — every member
 * may be asleep — so the decision has to be made in advance, by policy, and the
 * record of what happened has to be good enough to review afterwards.
 *
 * That trade is the honest cost of a workspace that outlives its members: writes
 * land without a human in the loop. What makes it acceptable is that every write
 * is committed as the agent that asked, so `git log` says who did what and `git
 * revert` undoes it — the container's substitute for Cmd+Z.
 */

import { writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { matchesAllowlist } from "@mpa/workspace-core";
import type { ApprovalGate, Requester, ToolResult, WriteProposal } from "@mpa/workspace-core";

export interface CommandPolicy {
  /**
   * Prefixes an agent may run unattended. Empty means no commands at all, which
   * is a sane way to run a room that only needs reading and writing.
   */
  allow: string[];
  /** Let anything run. Only defensible in a sandbox nobody else shares. */
  allowAll: boolean;
}

export interface ContainerGateOptions {
  policy: CommandPolicy;
  /** Commit a change, attributed to the agent that made it. */
  commit(proposal: WriteProposal): Promise<void>;
  /**
   * Tell the room a path changed, so open tabs and caches drop it.
   *
   * Absolute, because only the host knows what it is relative to — and the root
   * it is relative to must be the *real* one. `resolveSafePath` returns resolved
   * paths, so comparing against a syntactic root silently produced nonsense the
   * moment any ancestor was a link.
   */
  onChanged(absPath: string): void;
  /** Where the checkout is, for turning git's relative paths back into absolutes. */
  rootFor(): string;
  /**
   * Run write-then-commit with exclusive access to the working tree.
   *
   * Both halves belong in one critical section. `git commit -- <path>` records
   * whatever is on disk when it runs, so two agents writing the same file
   * interleaved their bytes and one of them committed a file neither had
   * written, under their own name.
   *
   * Required rather than optional: a caller that forgets it gets silent data
   * loss under concurrency, which is exactly how this shipped the first time.
   * A gate with no repository behind it passes an identity function, and says so.
   */
  serialise<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Commit and announce whatever a command changed.
   *
   * Returns the paths it touched, so the room hears about them.
   */
  commitCommandOutput(requester: Requester | undefined): Promise<string[]>;
}

export class ContainerGate implements ApprovalGate {
  constructor(private readonly opts: ContainerGateOptions) {}

  /**
   * No human, so no `awaiting-approval` — reporting it would make the relay wait
   * five minutes for a decision nobody is making.
   */
  async approveCommand(command: string, _requester: Requester | undefined): Promise<boolean> {
    return isAllowed(command, this.opts.policy);
  }

  /**
   * A command may have written files, and nothing else would notice.
   *
   * Serialised with writes for the same reason they are serialised with each
   * other: `git add -A` here must not run inside another agent's commit.
   */
  async afterCommand(requester: Requester | undefined): Promise<void> {
    const changed = await this.opts.serialise(() => this.opts.commitCommandOutput(requester));
    for (const rel of changed) this.opts.onChanged(path.resolve(this.opts.rootFor(), rel));
  }

  async applyWrite(p: WriteProposal): Promise<ToolResult> {
    p.report("running");
    const run = async (): Promise<boolean> => {
      await mkdir(path.dirname(p.abs), { recursive: true });
      await writeFile(p.abs, p.proposed, "utf8");
      try {
        await this.opts.commit(p);
        return true;
      } catch {
        return false;
      }
    };

    const committed = await this.opts.serialise(run);

    // The room hears about the change either way: the bytes are on disk, so
    // every member's cache is stale regardless of whether git knows.
    this.opts.onChanged(p.abs);

    const verb = p.existed ? "Updated" : "Created";
    if (committed) return { content: `${verb} ${p.rawPath}.` };
    // isError, not prose. An agent reads the flag; it may never read a sentence
    // explaining that its work exists on one disposable disk and nowhere else.
    return {
      content: `${verb} ${p.rawPath}, but it could not be committed — it is on the workspace disk only and will be lost if this container is replaced.`,
      isError: true,
    };
  }
}

/**
 * Does the policy permit this command?
 *
 * The matching itself lives in @mpa/workspace-core so the editor and the
 * container cannot drift apart; only allowAll is specific to a container, where
 * there is no human to ask.
 *
 * An allowlist here is a *trust decision*, not a sandbox. `npm test` runs
 * whatever the package.json says, and an agent can write package.json — so
 * allowlisting a build tool means trusting everyone in the room with code
 * execution in this container. That is a reasonable thing to choose; it is not
 * a reasonable thing to choose by accident. What the container does about it is
 * keep its own credentials out of reach: see withoutSecrets.
 */
export function isAllowed(command: string, policy: CommandPolicy): boolean {
  if (command.trim() === "") return false;
  if (policy.allowAll) return true;
  return matchesAllowlist(command, policy.allow);
}
