// Minimal type surface for VS Code's built-in git extension API (vscode.git).
// Trimmed from microsoft/vscode extensions/git/src/api/git.d.ts to just what
// this extension consumes: identity's repo lookup and the git_status tool.
//
//   vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports.getAPI(1)

import * as vscode from "vscode";

export interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
  getRepository(uri: vscode.Uri): Repository | null;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { name: string; remote: string };
  readonly ahead?: number;
  readonly behind?: number;
}

/** Mirrors the `Status` enum from vscode.git's api/git.d.ts. */
export enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}

export interface Change {
  readonly uri: vscode.Uri;
  readonly status: Status;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly mergeChanges: Change[];
  readonly onDidChange: vscode.Event<void>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

/** Resolve the built-in git extension's API, activating it on demand. */
export async function resolveGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) {
    return undefined;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  try {
    return ext.exports.getAPI(1);
  } catch {
    return undefined;
  }
}
