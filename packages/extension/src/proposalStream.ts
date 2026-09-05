// Sends one complete temporary patch at a time. Unlike DraftStream this never
// accumulates provider fragments: adapters emit only a bounded patch they have
// actually observed, and the relay owns identity, lifetime and room quotas.

import type { AgentProposalCancelMsg, AgentProposalMsg } from "@ripieno/protocol";

type ProposalFrame = AgentProposalMsg | AgentProposalCancelMsg;

export class ProposalStream {
  private sequence = 0;
  private active = false;

  constructor(private readonly send: (message: ProposalFrame) => void) {}

  publish(path: string, patch: string): void {
    this.sequence += 1;
    this.active = true;
    this.send({
      t: "agentProposal",
      path,
      patch,
      locationScope: "shared",
      sequence: this.sequence,
    });
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.send({ t: "agentProposalCancel" });
  }

  dispose(): void {
    this.cancel();
  }
}
