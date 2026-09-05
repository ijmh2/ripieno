// Read-only documents for relay-owned temporary patch text. Opening one is a
// review action only: this module deliberately has no WorkspaceEdit or apply
// function, so it cannot become a second approval path by accident.

import * as vscode from "vscode";
import type { AgentProposal } from "@ripieno/protocol";

export const LIVE_PROPOSAL_SCHEME = "ripieno-proposal";

export class LiveProposalDocuments implements vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly uriByProposal = new Map<string, vscode.Uri>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(
    LIVE_PROPOSAL_SCHEME,
    {
      onDidChange: this.changed.event,
      provideTextDocumentContent: (uri) => this.contents.get(uri.toString()) ?? "",
    }
  );

  set(proposal: AgentProposal): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: LIVE_PROPOSAL_SCHEME,
      authority: proposal.id,
      path: `/${proposal.path}.diff`,
    });
    this.contents.set(uri.toString(), proposal.patch);
    this.uriByProposal.set(proposal.id, uri);
    this.changed.fire(uri);
    return uri;
  }

  clear(proposalId: string): void {
    const uri = this.uriByProposal.get(proposalId);
    this.uriByProposal.delete(proposalId);
    if (uri) {
      this.contents.delete(uri.toString());
      this.changed.fire(uri);
    }
  }

  clearAll(): void {
    const uris = [...this.uriByProposal.values()];
    this.contents.clear();
    this.uriByProposal.clear();
    for (const uri of uris) this.changed.fire(uri);
  }

  dispose(): void {
    this.contents.clear();
    this.uriByProposal.clear();
    this.registration.dispose();
    this.changed.dispose();
  }
}
