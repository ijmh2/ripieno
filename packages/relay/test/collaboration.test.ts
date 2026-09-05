import { FileRoomStore } from "../src/roomStore.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CollaborationRecord, RosterEntry } from "@ripieno/protocol";
import { validateCollaboration, canAdvanceAssignedWork } from "../src/collaboration.js";
import { Room, type SocketLike } from "../src/room.js";
const roster = [{handle:"alice",role:"owner"},{handle:"bob",role:"member"}] as RosterEntry[];
const task = (): CollaborationRecord => ({type:"task",assigneeHandle:"bob",progress:"todo",steps:[]});
const plan = (): CollaborationRecord => ({type:"plan",progress:"todo",steps:[{id:"a",text:"Design",status:"todo",dependsOn:[],assigneeHandle:"bob"},{id:"b",text:"Build",status:"todo",dependsOn:["a"]}]});
test("relay validates human ownership, exact code anchor coordinates, and dependencies",()=>{
  assert.equal(validateCollaboration(task(),roster,[],[]),undefined);
  assert.match(validateCollaboration({...task(),assigneeHandle:"ghost"},roster,[],[])!,/member/);
  assert.match(validateCollaboration({...task(),anchor:{path:"../secrets",workspaceHost:"alice",startLine:1,endLine:1,sha256:"a".repeat(64)}},roster,[],[])!,/anchor/);
  const p=plan(); p.steps[0].dependsOn=["b"]; assert.match(validateCollaboration(p,roster,[],[])!,/cycle/);
  const blocked=plan(); blocked.steps[1].status="doing";assert.match(validateCollaboration(blocked,roster,[],[])!,/prerequisite/);
  blocked.steps[0].status="done";blocked.progress="doing";assert.equal(validateCollaboration(blocked,roster,[],[]),undefined);
});
test("expired claim links survive edits but new links must match assignee and goal",()=>{
  const t={...task(),claimId:"expired"}; assert.equal(validateCollaboration({...t,progress:"doing"},roster,[],[],t),undefined);
  assert.match(validateCollaboration(t,roster,[],[])!,/claim/);
  assert.match(validateCollaboration({...t,assigneeHandle:"alice"},roster,[],[],t)!,/claim/);
});
test("assignee can advance only own steps and cannot reassign or change detail",()=>{
  const p=plan();const next=structuredClone(p);next.steps[0].status="done";next.progress="doing";
  assert.equal(canAdvanceAssignedWork(p,next,"bob"),true);
  next.steps[1].status="done";assert.equal(canAdvanceAssignedWork(p,next,"bob"),false);
  assert.equal(canAdvanceAssignedWork(task(),{...task(),assigneeHandle:"alice"},"bob"),false);
});
class Socket implements SocketLike { readonly OPEN=1;readyState=1;send(_text:string){}close(){} }
async function roomFixture(){ const room=new Room("collaboration",{async sendRoster(){},async say(){},async resolveToolCall(){}});await room.join({handle:"alice",displayName:"Alice"},new Socket());await room.join({handle:"bob",displayName:"Bob"},new Socket()); return room; }
test("assigned work is durable, attributed, versioned, and protected against agent edits",async()=>{
  const room=await roomFixture();const alice={handle:"alice",role:"human" as const};const bob={handle:"bob",role:"human" as const};
  const made=room.createContext(alice,"create","note","Fix code","Rationale",[],task());assert.equal(made.ok,true);
  const changed=room.updateContext(bob,"progress",made.item!.id,1,{collaboration:{...task(),progress:"doing"}});assert.equal(changed.ok,true);
  assert.equal(changed.item!.authorHandle,"alice"); assert.equal(changed.contextAudit!.at(-1)!.actorHandle,"bob");
  assert.equal(room.updateContext(bob,"spoof",made.item!.id,2,{body:"Spoofed rationale",collaboration:task()}).ok,false);
  assert.equal(room.updateContext(bob,"stale",made.item!.id,1,{collaboration:task()}).ok,false);
  const restored=await roomFixture();restored.hydrate(room.snapshot());assert.deepEqual(restored.contextList[0].collaboration,changed.item!.collaboration);
  assert.equal(room.createContext({handle:"bob",role:"agent",agentId:"bob:bot"},"agent","note","Auto assign","",[],task()).ok,false);
});
test("discussion replies use relay-authenticated authors and plan text is redacted",async()=>{
  const room=await roomFixture();const owner={handle:"alice",role:"human" as const};const parent=room.createContext(owner,"parent","note","Discuss","",[],task());
  const reply=room.createContext({handle:"bob",role:"human"},"reply","note","Reply","My view",[],{type:"memory",replyTo:parent.item!.id,progress:"todo",steps:[]});assert.equal(reply.item!.authorHandle,"bob");
  const p=plan();p.steps[0].text="token sk-abcdefghijklmnop";const saved=room.createContext(owner,"plan","note","Plan","",[],p);assert.match(saved.item!.collaboration!.steps[0].text,/REDACTED/);
  const replay=room.createContext(owner,"plan","note","Plan","",[],p);assert.equal(replay.item!.id,saved.item!.id);
});

test("plan progress is derived from step state",()=>{
 const p=plan();assert.match(validateCollaboration({...p,progress:"doing"},roster,[],[])!,/progress/);
 p.steps[0].status="done";p.steps[1].status="done";assert.match(validateCollaboration(p,roster,[],[])!,/progress/);
 p.progress="done";assert.equal(validateCollaboration(p,roster,[],[]),undefined);
});

test("JSON file storage preserves anchors, plan owners and request receipts across restart",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ripieno-collaboration-store-"));
 try {
   const room=await roomFixture();const owner={handle:"alice",role:"human" as const};const p=plan();p.anchor={path:"src/a.ts",workspaceHost:"alice",startLine:2,endLine:3,sha256:"a".repeat(64)};
   const saved=room.createContext(owner,"persist","note","Shared plan","Rationale",[],p);
   const store=new FileRoomStore(dir);await store.save("collaboration",room.snapshot());const json=await new FileRoomStore(dir).load("collaboration");assert.ok(json);
   const restored=await roomFixture();restored.hydrate(json!);assert.deepEqual(restored.contextList[0],JSON.parse(JSON.stringify(saved.item)));
   const replay=restored.createContext(owner,"persist","note","Shared plan","Rationale",[],p);assert.equal(replay.item!.id,saved.item!.id);assert.equal(restored.contextList.length,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});
