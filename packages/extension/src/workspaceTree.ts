// The Shared Workspace tree — the host's files, browsable from the sidebar.
//
// Clicking a file opens it as an ordinary document through the filesystem
// provider, so it lands in a real editor tab rather than a preview pane. The
// tree is the default surface because it never touches workspace folders;
// mounting the same URI into the Explorer is a separate, opt-in command, since
// changing workspace folders can restart the extension host and would drop
// everyone's agents mid-room.

import * as vscode from "vscode";
import { WORKSPACE_SCHEME, uriFor } from "./workspaceFs";

interface Node {
  /** Workspace-relative, "" for the root. */
  path: string;
  name: string;
  directory: boolean;
}

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<Node> {
  static readonly viewId = "ripieno.workspace";

  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Whose workspace this is, for the view title. Undefined when unhosted. */
  private host: string | undefined;

  setHost(host: string | undefined): void {
    this.host = host;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  get hostHandle(): string | undefined {
    return this.host;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.host) return [];
    const dir = node?.path ?? "";

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uriFor(dir));
    } catch {
      // A host that vanished mid-browse is normal, not exceptional — show
      // nothing rather than throwing inside the tree.
      return [];
    }

    return entries
      .map(([name, type]) => ({
        name,
        path: dir ? `${dir}/${name}` : name,
        directory: (type & vscode.FileType.Directory) !== 0,
      }))
      // Directories first, then alphabetical — the ordering every file tree uses.
      .sort((a, b) =>
        a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1
      );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.directory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = uriFor(node.path);
    item.contextValue = node.directory ? "mpaWorkspaceDir" : "mpaWorkspaceFile";

    if (!node.directory) {
      // `vscode.open` rather than a custom command: it gives a normal editor
      // tab, with the language detected from the file name as usual.
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [uriFor(node.path)],
      };
    }
    return item;
  }
}

/** True when a document belongs to somebody else's workspace. */
export function isHostDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === WORKSPACE_SCHEME;
}
