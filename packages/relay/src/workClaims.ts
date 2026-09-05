import { randomUUID } from "node:crypto";
import {
  MAX_WORK_CLAIMS, MAX_WORK_CLAIMS_PER_MEMBER, WORK_CLAIM_TTL_MS,
  type WorkClaim, type WorkClaimResultMsg, type WorkClaimStateMsg,
} from "@ripieno/protocol";

/** Identity and field validation are performed by Room before entering here. */
export class WorkClaimStore {
  private readonly claims = new Map<string, WorkClaim>();
  private readonly requests = new Map<string, { fingerprint: string; result: WorkClaimResultMsg }>();
  private revision = 0;
  private readonly rates = new Map<string, { at: number; count: number }>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly publish: (state: WorkClaimStateMsg) => void) {}

  snapshot(): WorkClaimStateMsg {
    this.expire();
    return { t: "workClaims", claims: [...this.claims.values()].map(c => ({ ...c, paths: [...c.paths] })), revision: this.revision };
  }

  create(ownerHandle: string, ownerName: string, requestId: string,
    input: Pick<WorkClaim, "task" | "paths" | "agentId" | "goalId" | "workspaceHost">): WorkClaimResultMsg {
    this.expire();
    if (!this.admit(ownerHandle)) return this.fail(requestId, "Too many claim changes. Try again shortly.");
    const key = JSON.stringify([ownerHandle, requestId]);
    const fingerprint = JSON.stringify(input);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return this.fail(requestId, "That request ID already describes another claim.");
      if (previous.result.claimId && !this.claims.has(previous.result.claimId)) {
        return this.fail(requestId, "That claim has ended. Submit a new claim to start again.");
      }
      return { ...previous.result };
    }
    if (this.claims.size >= MAX_WORK_CLAIMS || [...this.claims.values()].filter(c => c.ownerHandle === ownerHandle).length >= MAX_WORK_CLAIMS_PER_MEMBER) {
      return this.fail(requestId, "Release existing work before claiming more.");
    }
    if (input.goalId && [...this.claims.values()].some(c => c.goalId === input.goalId)) {
      return this.fail(requestId, "Someone already holds that goal. Coordinate with its owner before taking it.");
    }
    const now = Date.now();
    const claim: WorkClaim = { ...input, paths: [...input.paths], id: randomUUID(), ownerHandle, ownerName, createdAt: now, expiresAt: now + WORK_CLAIM_TTL_MS };
    this.claims.set(claim.id, claim);
    const result: WorkClaimResultMsg = { t: "workClaimResult", requestId, ok: true, claimId: claim.id };
    this.requests.set(key, { fingerprint, result });
    // Keep active create receipts so a reconnect cannot duplicate a live claim.
    if (this.requests.size > 256) {
      for (const [id, receipt] of this.requests) {
        if (!receipt.result.claimId || !this.claims.has(receipt.result.claimId)) this.requests.delete(id);
        if (this.requests.size <= 256) break;
      }
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.expire(), 5_000);
      this.timer.unref?.();
    }
    this.changed();
    return result;
  }

  release(owner: string, requestId: string, claimId: string): WorkClaimResultMsg {
    if (!this.admit(owner)) return this.fail(requestId, "Too many claim changes. Try again shortly.");
    this.expire();
    const claim = this.claims.get(claimId);
    if (claim && claim.ownerHandle !== owner) return this.fail(requestId, "Only the person holding this work may release it.");
    if (this.claims.delete(claimId)) this.changed();
    return { t: "workClaimResult", requestId, ok: true, claimId };
  }

  renew(owner: string, ids: string[]): void {
    this.expire();
    let changed = false;
    const now = Date.now();
    for (const id of new Set(ids)) {
      const claim = this.claims.get(id);
      // Ignore frequent renewal frames rather than amplify them into broadcasts.
      if (!claim || claim.ownerHandle !== owner || claim.expiresAt - now > WORK_CLAIM_TTL_MS - 15_000) continue;
      claim.expiresAt = now + WORK_CLAIM_TTL_MS;
      changed = true;
    }
    if (changed) this.changed();
  }

  removeWhere(predicate: (claim: WorkClaim) => boolean): void {
    let removed = false;
    for (const [id, claim] of this.claims) if (predicate(claim)) { this.claims.delete(id); removed = true; }
    if (removed) this.changed();
  }

  private expire(): void { this.removeWhere(c => c.expiresAt <= Date.now()); }
  private admit(owner: string): boolean {
    const now = Date.now();
    const rate = this.rates.get(owner);
    if (rate && now - rate.at < 1_000) return ++rate.count <= 8;
    this.rates.set(owner, { at: now, count: 1 });
    if (this.rates.size > 256) this.rates.delete(this.rates.keys().next().value!);
    return true;
  }
  private changed(): void {
    this.revision++;
    if (!this.claims.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.publish({ t: "workClaims", claims: [...this.claims.values()].map(c => ({ ...c, paths: [...c.paths] })), revision: this.revision });
  }
  private fail(requestId: string, message: string): WorkClaimResultMsg { return { t: "workClaimResult", requestId, ok: false, message }; }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.claims.clear(); this.requests.clear(); }
}
