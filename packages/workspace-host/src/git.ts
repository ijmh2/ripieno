/**
 * The workspace as a git repository.
 *
 * Choosing git as the source of truth is what makes the container disposable:
 * lose it, re-clone, lose nothing that was committed. It also turns provenance
 * from something the room remembers into something the repo remembers — every
 * write is committed as the agent that made it, so `git log` outlives the room,
 * the relay and this whole project.
 *
 * Access is a per-room SSH deploy key rather than anyone's GitHub token. A token
 * in a container's volume would be a standing liability with reach far beyond
 * one repo; a deploy key is write-scoped to a single repository and revocable
 * from that repository's own settings page.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Requester } from "@mpa/workspace-core";

const execAsync = promisify(exec);

export interface RepoBinding {
  owner: string;
  name: string;
  branch: string;
  /**
   * Where to clone from. Defaults to GitHub over SSH.
   *
   * Overridable because not every repository lives on github.com — a
   * self-hosted forge is a legitimate deployment, and it keeps the tests able to
   * exercise the real clone/commit/push path against a local bare repo instead
   * of reaching inside this class to disable it.
   */
  url?: string;
}

export interface GitWorkspaceOptions {
  root: string;
  keyDir: string;
  repo?: RepoBinding;
  /** Say something in the room — used for the things a member must act on. */
  announce(message: string): void;
}

export class GitWorkspace {
  private pushTimer: NodeJS.Timeout | undefined;
  private pushing = false;
  /** The push currently running, so a second caller can await it rather than skip. */
  private inFlight: Promise<void> | undefined;
  /** A commit arrived while a push was running; the remote is behind again. */
  private pushDirty = false;
  /** Set once a push has been refused, so the room is told once, not per write. */
  private blocked = false;
  /** Serialises everything that touches the working tree. See exclusive(). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: GitWorkspaceOptions) {}

  get bound(): boolean {
    return this.opts.repo !== undefined;
  }

  private get keyPath(): string {
    return path.join(this.opts.keyDir, "deploy_key");
  }

  /**
   * Git configured to use this room's deploy key and nothing else.
   *
   * `IdentitiesOnly` matters: without it ssh offers every key an agent forwards
   * or the image happens to ship, and a push can succeed under an identity we
   * never intended to use.
   */
  private get sshEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i ${this.keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    };
  }

  /** Generate the room's deploy key if it has none, and return the public half. */
  async ensureDeployKey(): Promise<string> {
    await mkdir(this.opts.keyDir, { recursive: true });
    const pub = `${this.keyPath}.pub`;
    try {
      await access(pub);
    } catch {
      await execAsync(
        `ssh-keygen -t ed25519 -N "" -C "multiplayer-agent room workspace" -f ${this.keyPath}`
      );
    }
    // ssh refuses to use a key others can read, and a fresh volume does not
    // always give us the mode we expect.
    await chmod(this.keyPath, 0o600).catch(() => undefined);
    return (await readFile(pub, "utf8")).trim();
  }

  /**
   * Make sure the working tree exists.
   *
   * Never resets or pulls over existing work: if the directory is already a
   * repo, it is left exactly as it is. A container restarting mid-session must
   * not silently discard commits that have not been pushed yet.
   */
  async ensureClone(): Promise<{ ok: boolean; message: string }> {
    const repo = this.opts.repo;
    if (!repo) {
      await mkdir(this.opts.root, { recursive: true });
      return { ok: true, message: "No repository bound; the workspace is a scratch directory." };
    }

    if (await this.isRepo()) {
      return { ok: true, message: `Workspace already checked out at ${repo.owner}/${repo.name}.` };
    }

    await mkdir(path.dirname(this.opts.root), { recursive: true });
    const url = repo.url ?? `git@github.com:${repo.owner}/${repo.name}.git`;
    try {
      await execAsync(
        `git clone --branch ${shellQuote(repo.branch)} ${shellQuote(url)} ${shellQuote(this.opts.root)}`,
        { env: this.sshEnv, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }
      );
      await this.configureIdentity();
      return { ok: true, message: `Cloned ${repo.owner}/${repo.name} (${repo.branch}).` };
    } catch (err) {
      const detail = detailOf(err);
      // By far the most common first-run failure, and unrecoverable without a
      // human, so say exactly what to do rather than just reporting a git error.
      if (/Permission denied|could not read from remote/i.test(detail)) {
        return {
          ok: false,
          message:
            `Cannot reach ${repo.owner}/${repo.name}. Add this room's deploy key to that ` +
            `repository (Settings → Deploy keys → Add, with write access):\n\n${await this.ensureDeployKey()}`,
        };
      }
      return { ok: false, message: `Could not clone ${repo.owner}/${repo.name}: ${detail}` };
    }
  }

  private async isRepo(): Promise<boolean> {
    try {
      await access(path.join(this.opts.root, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The committer is the workspace; the author is whichever agent asked.
   *
   * That is the literal truth of what happened, and keeping them distinct is
   * what stops every agent's work collapsing into one identity the moment the
   * workspace stopped being somebody's laptop.
   */
  private async configureIdentity(): Promise<void> {
    await this.run('git config user.name "Shared workspace"');
    await this.run('git config user.email "workspace@users.noreply.github.com"');
  }

  /**
   * Run something with exclusive access to the working tree.
   *
   * Git takes `.git/index.lock` for the duration of an `add` or a `commit`, so
   * two agents writing at the same time meant one of them simply lost: the
   * command threw, the file stayed on disk uncommitted, and the container is
   * meant to be disposable — so it was gone at the next redeploy. Six concurrent
   * writes produced one commit.
   *
   * The write itself belongs inside the same critical section, not just the git
   * commands: `git commit -- <path>` records whatever is on disk at that moment,
   * so an interleaved write meant one agent's commit contained another agent's
   * bytes, under the wrong name.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Swallow here only so one failure does not poison every later caller; the
    // rejection is still delivered to whoever asked for this piece of work.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Commit one path, authored by the agent that wrote it. */
  async commit(relPath: string, requester: Requester | undefined, summary: string): Promise<void> {
    if (!(await this.isRepo())) return;

    const author = requester
      ? `${requester.label} <${requester.handle}+agent@users.noreply.github.com>`
      : "Shared workspace <workspace@users.noreply.github.com>";

    await this.run(`git add -- ${shellQuote(relPath)}`);
    // Nothing staged means the write was a no-op against HEAD — not an error.
    const { stdout } = await execAsync("git diff --cached --name-only", {
      cwd: this.opts.root,
      env: process.env,
    });
    if (stdout.trim() === "") return;

    await this.run(
      `git commit --author=${shellQuote(author)} -m ${shellQuote(summary)} -- ${shellQuote(relPath)}`
    );
    this.schedulePush();
  }

  /**
   * Push on idle rather than per commit.
   *
   * An agent editing a file five times in ten seconds should produce five
   * commits and one push; pushing each time would spend most of the session
   * waiting on the network for work that is about to be superseded.
   */
  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), 5_000);
    this.pushTimer.unref();
  }

  async push(): Promise<void> {
    const repo = this.opts.repo;
    if (!repo) return;
    // A second caller waits for the one already running instead of returning as
    // though it had pushed. It also records that the remote is behind again:
    // this used to drop the commit entirely, with nothing left to re-arm the
    // timer, so the last write of a session could stay local forever.
    if (this.pushing) {
      this.pushDirty = true;
      await this.inFlight;
      return;
    }
    if (!(await this.isRepo())) return;
    this.pushing = true;
    const done = this.doPush(repo);
    this.inFlight = done;
    try {
      await done;
    } finally {
      this.pushing = false;
      this.inFlight = undefined;
      if (this.pushDirty) {
        this.pushDirty = false;
        this.schedulePush();
      }
    }
  }

  private async doPush(repo: RepoBinding): Promise<void> {
    try {
      await execAsync(`git push origin HEAD:${shellQuote(repo.branch)}`, {
        cwd: this.opts.root,
        env: this.sshEnv,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (this.blocked) {
        this.blocked = false;
        this.opts.announce("The workspace is back in sync with the repository.");
      }
    } catch (err) {
      const detail = detailOf(err);
      if (!this.blocked) {
        this.blocked = true;
        // Never rebase or force-push somebody's repository to clear this. The
        // commits are safe locally; a human decides how the histories meet.
        this.opts.announce(
          /non-fast-forward|rejected|fetch first/i.test(detail)
            ? `Push rejected — ${repo.owner}/${repo.name} has moved on since this workspace cloned it. ` +
                "Work is committed here and safe, but it will not reach the repository until someone " +
                "reconciles the two histories. Nothing has been force-pushed."
            : `Could not push to ${repo.owner}/${repo.name}: ${detail}`
        );
      }
    }
  }

  /** Push whatever is pending, e.g. on shutdown. */
  async flush(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    // Twice at most: the first await may only be joining a push that started
    // before the newest commits existed.
    await this.push();
    if (this.pushDirty) {
      this.pushDirty = false;
      if (this.pushTimer) {
        clearTimeout(this.pushTimer);
        this.pushTimer = undefined;
      }
      await this.push();
    }
  }

  private async run(command: string): Promise<void> {
    await execAsync(command, { cwd: this.opts.root, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  }
}

/** Single-quote for /bin/sh. Repo names and agent labels both reach the shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseRepo(
  spec: string | undefined,
  branch: string,
  url?: string
): RepoBinding | undefined {
  if (!spec) return undefined;
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(spec.trim());
  if (!match) return undefined;
  return { owner: match[1]!, name: match[2]!, branch, url };
}

function detailOf(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(err)).trim().slice(0, 500);
}
