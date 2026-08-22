// The editor half of the approval bridge.
//
// Listens on loopback for permission requests from a room agent's
// permissionServer, shows the member a modal, and sends the verdict back. This
// is what turns "the agent stranded on an unanswerable prompt" into an ordinary
// decision — and it is why a room agent can be fully capable without being
// unconditionally trusted.

import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { approvalInputHash } from "./approvalScope";
import {
  canStoreStandingApproval,
  summariseApprovalInput,
  type ApprovalSummary,
} from "./approvalSummary";

interface Request {
  id: string;
  agentId: string;
  agentLabel: string;
  toolName: string;
  input: unknown;
}

export interface ApprovalBridgeInfo {
  url: string;
  token: string;
}

export type ApprovalChoice = "once" | "always" | "deny";

/**
 * Renders the request somewhere the member will see it and resolves with their
 * answer. Returning undefined means "I could not ask" — the bridge then falls
 * back to a modal, so a request never strands just because a panel is hidden.
 */
export type ApprovalPrompt = (request: {
  agentLabel: string;
  toolName: string;
  summary: string;
  rememberable: boolean;
}) => Promise<ApprovalChoice | undefined>;

export class ApprovalBridge implements vscode.Disposable {
  private wss: WebSocketServer | undefined;
  private readonly token = randomBytes(24).toString("hex");
  private ready: Promise<ApprovalBridgeInfo> | undefined;
  /** Remembered "always allow" answers, per agent, for this session only. */
  private readonly standing = new Set<string>();
  /** Set by the extension once the room view exists; falls back to a modal. */
  private prompt: ApprovalPrompt | undefined;

  /** Prefer an inline prompt in the room panel over a focus-stealing modal. */
  setPrompt(prompt: ApprovalPrompt | undefined): void {
    this.prompt = prompt;
  }

  /** Starts on first use; the port is chosen by the OS and never fixed. */
  start(): Promise<ApprovalBridgeInfo> {
    if (this.ready) return this.ready;

    this.ready = new Promise<ApprovalBridgeInfo>((resolve, reject) => {
      // Loopback only. This socket decides what runs on the member's machine,
      // so it must never be reachable from another host.
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
        const address = wss.address();
        if (typeof address === "string" || address === null) {
          reject(new Error("approval bridge could not bind"));
          return;
        }
        resolve({ url: `ws://127.0.0.1:${address.port}`, token: this.token });
      });
      this.wss = wss;

      wss.on("error", reject);
      wss.on("connection", (socket, req) => {
        // A shared secret as well as loopback: another local process should not
        // be able to answer, or ask, on the member's behalf.
        if (req.headers["x-ripieno-token"] !== this.token) {
          socket.close(4001, "bad token");
          return;
        }
        socket.on("message", (raw) => void this.handle(socket, raw));
      });
    });

    return this.ready;
  }

  private async handle(socket: WebSocket, raw: unknown): Promise<void> {
    let request: Request;
    try {
      request = JSON.parse(String(raw)) as Request;
    } catch {
      return;
    }

    const verdict = await this.decide(request);
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ id: request.id, ...verdict }));
    }
  }

  private async decide(request: Request): Promise<{ allow: boolean; message?: string }> {
    // Standing approvals are a trust boundary, so identity must come from the
    // full request rather than the truncated, human-readable summary. Two long
    // commands with the same first 600 characters must never share consent.
    const key = `${request.agentId}:${request.toolName}:${approvalInputHash(request.input)}`;
    if (this.standing.has(key)) {
      return { allow: true };
    }

    const summary = summariseApprovalInput(request.input);
    const choice = await this.ask(request, summary);

    if (canStoreStandingApproval(choice ?? "", summary.rememberable)) {
      this.standing.add(key);
      return { allow: true };
    }
    // A forged or stale UI may still return "always" for an input whose full
    // value was not shown. Treat that as permission for this run only; never let
    // presentation state widen into a standing host grant.
    if (choice === "once" || choice === "always") {
      return { allow: true };
    }
    return {
      allow: false,
      message:
        "The member declined. Do not retry the same call — explain what you need it for, or take a different route.",
    };
  }

  /**
   * Ask inline if the room panel can show it, otherwise fall back to a modal.
   * Never silently skip: an unasked question would time out as a denial and the
   * member would never know why their agent stalled.
   */
  private async ask(
    request: Request,
    summary: ApprovalSummary
  ): Promise<ApprovalChoice | undefined> {
    if (this.prompt) {
      const inline = await this.prompt({
        agentLabel: request.agentLabel,
        toolName: request.toolName,
        summary: summary.text,
        rememberable: summary.rememberable,
      });
      if (inline) return inline;
    }

    const detail = [
      `Tool: ${request.toolName}`,
      "",
      summary.text,
      "",
      summary.rememberable
        ? "This was requested by an agent in a shared room — other members' messages influence what it asks for. A remembered approval applies only to this exact request from this agent, for this editor session."
        : "This was requested by an agent in a shared room — other members' messages influence what it asks for. This summary does not show the full exact input, so approval can apply to this run only.",
    ].join("\n");

    const answer = summary.rememberable
      ? await vscode.window.showWarningMessage(
          `${request.agentLabel} wants permission`,
          { modal: true, detail },
          "Allow once",
          "Always allow exact request",
          "Deny"
        )
      : await vscode.window.showWarningMessage(
          `${request.agentLabel} wants permission`,
          { modal: true, detail },
          "Allow once",
          "Deny"
        );
    if (answer === "Always allow exact request") return "always";
    if (answer === "Allow once") return "once";
    return "deny";
  }

  dispose(): void {
    this.wss?.close();
    this.wss = undefined;
    this.ready = undefined;
  }
}
