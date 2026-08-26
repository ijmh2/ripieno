import type { ClientMsg } from "@ripieno/protocol";

export type ContextMutationMsg = Extract<ClientMsg, { t: "contextCreate" | "contextUpdate" }>;

/** Keep context mutations until their relay-authoritative acknowledgement arrives. */
export class ContextMutationQueue {
  private readonly pending = new Map<string, { room: string; message: ContextMutationMsg }>();

  track(room: string, message: ContextMutationMsg): void {
    this.pending.set(message.requestId, { room, message: structuredClone(message) });
  }

  acknowledge(requestId: string): boolean {
    return this.pending.delete(requestId);
  }

  forRoom(room: string): ContextMutationMsg[] {
    return [...this.pending.values()]
      .filter((pending) => pending.room === room)
      .map((pending) => structuredClone(pending.message));
  }

  clear(): void {
    this.pending.clear();
  }
}
