import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { CollaborationRecord, ContextItem, Goal, RosterEntry, WorkClaim } from "@ripieno/protocol";
import type { ContextMutationMsg } from "./contextMutations";

export interface CollaborationSnapshot {
  online: boolean; supported?: boolean; connection?: unknown; room?: string; handle?: string; host?: string; root?: string;
  context: ContextItem[]; goals: Goal[]; claims: WorkClaim[]; roster: RosterEntry[];
}
export const digestCode = (text: string): string => createHash("sha256").update(text).digest("hex");
export function anchorMatches(item: ContextItem, host: string | undefined, text: string): boolean {
  return !!item.collaboration?.anchor && item.collaboration.anchor.workspaceHost === host && item.collaboration.anchor.sha256 === digestCode(text);
}
export class CollaborationCommands {
  constructor(private readonly snapshot: () => CollaborationSnapshot, private readonly mutate: (m: ContextMutationMsg) => void, private readonly uriFor: (path: string) => vscode.Uri | undefined) {}
  private current(s: CollaborationSnapshot): boolean {
    const now=this.snapshot();
    if (!now.online || now.supported === false || now.connection!==s.connection || now.room!==s.room || now.handle!==s.handle || now.host!==s.host || now.root!==s.root) { void vscode.window.showInformationMessage("Room or workspace changed. Start this action again in the current room."); return false; }
    return true;
  }
  async create(type: CollaborationRecord["type"]): Promise<void> {
    const s = this.snapshot();
    if (s.supported === false) { void vscode.window.showInformationMessage("This relay needs an update before it can save structured shared work."); return; }
    if (!s.online || !s.room || !s.handle || !s.roster.some(m => m.handle === s.handle && m.role !== "viewer")) { void vscode.window.showInformationMessage("Join a room as a member first."); return; }
    const record: CollaborationRecord = { type, progress:"todo", steps:[] };
    if (type === "comment" || type === "memory") {
      const editor = vscode.window.activeTextEditor;
      if (editor && s.host) {
        let relative: string | undefined;
        if (editor.document.uri.scheme === "file" && s.host === s.handle && s.root) relative = path.relative(s.root, editor.document.uri.fsPath).split(path.sep).join("/");
        if (editor.document.uri.scheme === "ripieno-workspace") relative = editor.document.uri.path.replace(/^\//, "");
        if (relative && !relative.startsWith("../") && !path.isAbsolute(relative) && this.uriFor(relative)?.toString() === editor.document.uri.toString()) record.anchor = { path:relative, workspaceHost:s.host, startLine:editor.selection.start.line+1, endLine:editor.selection.end.line+1, sha256:digestCode(editor.document.getText()) };
      }
      if (type === "comment" && !record.anchor) { void vscode.window.showInformationMessage("Select code in the room's hosted shared workspace to add a comment."); return; }
    }
    const title = await vscode.window.showInputBox({ title: `New shared ${type}`, prompt: "Title", validateInput:v => !v.trim() || v.length > 160 ? "Use 1–160 characters." : undefined }); if (!title) return;
    const body = await vscode.window.showInputBox({ title: `New shared ${type}`, prompt:"Detail or rationale (shared with everyone in the room)", validateInput:v => v.length > 4000 ? "Use at most 4,000 characters." : undefined }); if (body === undefined) return;
    if (type === "task") record.assigneeHandle = s.handle;
    if (type === "plan") {
      const lines = await vscode.window.showInputBox({ title:"Plan steps", prompt:"Separate steps with |. Steps initially run in order; edit dependencies from the plan.", validateInput:v => !v.trim() || v.split("|").length > 40 || v.split("|").some(t => !t.trim() || t.trim().length>500) ? "Enter 1–40 steps, each at most 500 characters." : undefined }); if (!lines) return;
      record.steps = lines.split("|").map((text,i) => ({ id:`step${i+1}`, text:text.trim(), status:"todo", dependsOn:i ? [`step${i}`] : [] }));
    }
    if (s.goals.length) { const g = await vscode.window.showQuickPick([{label:"No linked goal",id:undefined}, ...s.goals.filter(g=>g.status!=="completed").map(g=>({label:g.text,id:g.id}))], {title:"Link to a shared goal"}); if (!g) return; record.goalId=g.id; }
    if (!this.current(s)) return;
    this.mutate({t:"contextCreate",requestId:`ctxreq_${randomUUID()}`,kind:"note",title,body,tags:[],collaboration:record});
  }
  async open(id: string): Promise<void> {
    const s=this.snapshot(); const item=s.context.find(c=>c.id===id); const a=item?.collaboration?.anchor; if (!a || !item) return;
    const uri=this.uriFor(a.path);
    if (!uri || a.workspaceHost!==s.host) { void vscode.window.showWarningMessage("This anchor belongs to a different or offline workspace host."); return; }
    try {
      const doc=await vscode.workspace.openTextDocument(uri);
      if (!this.current(s)) return;
      if (!anchorMatches(item,this.snapshot().host,doc.getText())) { void vscode.window.showWarningMessage("The file has changed since this anchor was saved. Its original line range is stale; create a new anchored record after reviewing the current file."); return; }
      const editor=await vscode.window.showTextDocument(doc); const range=new vscode.Range(a.startLine-1,0,Math.min(a.endLine-1,doc.lineCount-1),doc.lineAt(Math.min(a.endLine-1,doc.lineCount-1)).text.length); editor.selection=new vscode.Selection(range.start,range.end); editor.revealRange(range);
    } catch(e) { void vscode.window.showWarningMessage(`Cannot open code anchor: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async edit(id: string, shortcut?: "Set progress" | "Assign human owner"): Promise<void> {
    const s=this.snapshot(); const item=s.context.find(c=>c.id===id); if (!item?.collaboration || !s.handle) return;
    const isEditor = item.authorHandle===s.handle || s.roster.some(m=>m.handle===s.handle&&m.role==="owner");
    const isAssignee = item.collaboration.assigneeHandle===s.handle || item.collaboration.steps.some(step=>step.assigneeHandle===s.handle);
    const r=structuredClone(item.collaboration);
    const action=shortcut ?? await vscode.window.showQuickPick([...(isEditor ? ["Assign human owner", ...(r.type!=="plan"?["Set progress"]:[]), "Link goal / work claim", ...(r.type==="plan"?["Update plan step", "Edit dependencies", "Assign step owner"]:[]), "Edit detail"] : isAssignee ? [...(r.type!=="plan"?["Set progress"]:[]), ...(r.type==="plan"?["Update plan step"]:[])] : []), "Add discussion reply"],{title:item.title}); if (!action) return;
    if (shortcut && (!isEditor && !(isAssignee && shortcut === "Set progress"))) return;
    if (shortcut === "Set progress" && r.type === "plan") return;
    let body=item.body;
    if (action==="Assign human owner") { const m=await vscode.window.showQuickPick(s.roster.filter(m=>m.role!=="viewer").map(m=>({label:`@${m.handle}`,handle:m.handle})),{title:"Human responsible for this work"}); if (!m) return; r.assigneeHandle=m.handle; if(r.type==="comment")r.type="task"; }
    if (action==="Set progress") { const p=await vscode.window.showQuickPick(["todo","doing","done"] as const); if (!p) return; r.progress=p as CollaborationRecord["progress"]; }
    if (action==="Link goal / work claim") {
      const g=await vscode.window.showQuickPick([{label:"No linked goal",id:undefined},...s.goals.map(g=>({label:g.text,id:g.id}))]); if(!g)return; r.goalId=g.id;
      const c=await vscode.window.showQuickPick([{label:"No linked claim",id:undefined},...s.claims.filter(c=>!r.goalId||c.goalId===r.goalId).map(c=>({label:c.task,id:c.id}))]); if(!c)return; r.claimId=c.id;
    }
    if (action==="Update plan step" || action==="Edit dependencies" || action==="Assign step owner") {
      const step=await vscode.window.showQuickPick(r.steps.filter(step=>isEditor || r.assigneeHandle===s.handle || step.assigneeHandle===s.handle).map(step=>({label:`${step.status}: ${step.text}`,id:step.id}))); if(!step)return;
      const target=r.steps.find(x=>x.id===step.id)!;
      if(action==="Update plan step") { const p=await vscode.window.showQuickPick(["todo","doing","done"] as const); if(!p)return; target.status=p as CollaborationRecord["progress"]; r.progress=r.steps.every(x=>x.status==="done")?"done":r.steps.some(x=>x.status!=="todo")?"doing":"todo"; }
      else if(action==="Assign step owner") {const owner=await vscode.window.showQuickPick(s.roster.filter(m=>m.role!=="viewer").map(m=>({label:`@${m.handle}`,handle:m.handle})));if(!owner)return;target.assigneeHandle=owner.handle;}
      else { const deps=await vscode.window.showQuickPick(r.steps.filter(x=>x.id!==step.id).map(x=>({label:x.text,id:x.id,picked:target.dependsOn.includes(x.id)})),{canPickMany:true,title:"Prerequisite steps (relay rejects cycles)"}); if(!deps)return; target.dependsOn=deps.map(d=>d.id); }
    }
    if(action==="Add discussion reply") {
      const text=await vscode.window.showInputBox({title:"Discussion reply (attributed by the relay)",validateInput:v=>!v.trim()||v.length>4000?"Use 1–4,000 characters.":undefined}); if(!text || !this.current(s))return;
      this.mutate({t:"contextCreate",requestId:`ctxreq_${randomUUID()}`,kind:"note",title:`Reply: ${item.title}`.slice(0,160),body:text,tags:[],collaboration:{type:"memory",replyTo:item.id,progress:"todo",steps:[]}});return;
    }
    if(action==="Edit detail") {const text=await vscode.window.showInputBox({title:action,value:body,validateInput:v=>v.length>4000?"Use at most 4,000 characters.":undefined});if(text===undefined)return;body=text;}
    if(!this.current(s))return;
    this.mutate({t:"contextUpdate",requestId:`ctxreq_${randomUUID()}`,contextId:id,expectedVersion:item.version,...(isEditor?{body}:{}),collaboration:r});
  }
}
