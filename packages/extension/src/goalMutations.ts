import type { ClientMsg } from "@ripieno/protocol";

export type GoalMutationMsg = Extract<ClientMsg, { t: "goalCreate" | "goalTransition" }>;

/**
 * Retains mutations until the relay acknowledges their request id.
 *
 * WebSocket delivery is not an acknowledgement: a connection may die after
 * the server commits but before the result reaches this extension. Re-sending
 * the same id after `joined` lets the relay replay it without duplicating work.
 */
export class GoalMutationQueue {
  private readonly pending = new Map<string, { room: string; message: GoalMutationMsg }>();

  track(room: string, message: GoalMutationMsg): void {
    this.pending.set(message.requestId, { room, message: structuredClone(message) });
  }

  acknowledge(requestId: string): boolean {
    return this.pending.delete(requestId);
  }

  forRoom(room: string): GoalMutationMsg[] {
    return [...this.pending.values()]
      .filter((pending) => pending.room === room)
      .map((pending) => structuredClone(pending.message));
  }

  clear(): void {
    this.pending.clear();
  }
}

