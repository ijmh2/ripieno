const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const Module=require("node:module");const resolve=Module._resolveFilename;
Module._resolveFilename=function(request,...rest){return request==="vscode"?path.join(__dirname,"vscode-stub.js"):resolve.call(this,request,...rest);};
const vscode=require("./vscode-stub.js");
vscode.Selection=class{constructor(start,end){this.start=start;this.end=end;}};
const {CollaborationCommands,digestCode,anchorMatches,continuationExport}=require("../dist/collaborationCommands.js");
function snapshot(){return {online:true,room:"room",handle:"alice",host:"alice",root:"/shared",context:[],goals:[],claims:[],roster:[{handle:"alice",role:"owner"},{handle:"bob",role:"member"}],handoffs:[]};}
function record(){return {id:"context_abc",title:"Review",body:"Rationale",tags:[],kind:"note",status:"accepted",authorHandle:"alice",version:1,collaboration:{type:"task",assigneeHandle:"bob",progress:"todo",steps:[]}};}
function harness(s){let current=s;const sent=[];const warnings=[];vscode.window.showInformationMessage=async t=>{warnings.push(t);};vscode.window.showWarningMessage=async t=>{warnings.push(t);};return {commands:new CollaborationCommands(()=>current,m=>sent.push(m),p=>vscode.Uri.file(`/shared/${p}`)),sent,warnings,set:s=>current=s};}
test("code anchors refuse changed content and a different workspace host",()=>{
 const item=record();item.collaboration.anchor={path:"a.ts",workspaceHost:"alice",startLine:1,endLine:2,sha256:digestCode("original")};
 assert.equal(anchorMatches(item,"alice","original"),true);assert.equal(anchorMatches(item,"alice","changed"),false);assert.equal(anchorMatches(item,"bob","original"),false);
});
test("native plan creation preserves ordered prerequisites and captures authoritative owner later at relay",async()=>{
 const h=harness(snapshot());const answers=["Release plan","Verify before release","Test | Package | Review"];vscode.window.showInputBox=async()=>answers.shift();
 await h.commands.create("plan");assert.equal(h.sent.length,1);assert.deepEqual(h.sent[0].collaboration.steps.map(s=>s.dependsOn),[[],["step1"],["step2"]]);assert.equal(h.sent[0].authorHandle,undefined);
});
test("a room switch during a native dialog aborts the mutation",async()=>{
 const s=snapshot();const h=harness(s);let calls=0;vscode.window.showInputBox=async()=>{if(calls++===0){h.set({...s,room:"other"});return "Task";}return "Details";};await h.commands.create("task");assert.equal(h.sent.length,0);assert.match(h.warnings.at(-1),/changed/);
});
test("assigned member can update progress without sending someone else's body",async()=>{
 const s=snapshot();s.handle="bob";s.context=[record()];const h=harness(s);const choices=["Set progress","doing"];vscode.window.showQuickPick=async()=>choices.shift();await h.commands.edit("context_abc");assert.equal(h.sent[0].collaboration.progress,"doing");assert.equal(h.sent[0].body,undefined);assert.equal(h.sent[0].expectedVersion,1);
});
test("discussion creates a separate attributed reply rather than rewriting the parent",async()=>{
 const s=snapshot();s.handle="bob";s.context=[record()];const h=harness(s);vscode.window.showQuickPick=async()=>"Add discussion reply";vscode.window.showInputBox=async()=>"A reviewer comment";await h.commands.edit("context_abc");assert.equal(h.sent[0].t,"contextCreate");assert.equal(h.sent[0].collaboration.replyTo,"context_abc");assert.equal(h.sent[0].body,"A reviewer comment");assert.equal(h.sent[0].authorHandle,undefined);
});
test("export uses an allowlist and does not serialize local configuration or provider continuation",()=>{
 const s=snapshot();s.context=[{...record(),body:"Private /Users/alice/keys and sk-abcdefghijklmnop"}];s.providerSession="secret-session";s.privatePath="/Users/private/key";s.handoffs=[{id:"h",task:"Continue",status:"outcomeUnknown",sourceOwnerHandle:"alice",targetHandle:"bob",continuation:{privateToken:"private-token"},nonce:"nonce-secret"}];
 const out=continuationExport(s);assert.match(out,/outcomeUnknown/);assert.match(out,/Manual continuation/);assert.doesNotMatch(out,/secret-session|private-token|nonce-secret|\/Users\/|sk-abcdefghijklmnop|\/shared/);
});

test("selected shared editor code creates an anchored comment and converts to an assigned task",async()=>{
 const s=snapshot();const h=harness(s);const uri=vscode.Uri.file("/shared/src/a.ts");vscode.window.activeTextEditor={document:{uri,getText:()=>"first\nsecond\nthird"},selection:{start:{line:1},end:{line:2}}};
 const answers=["Review this code","Check the condition"];vscode.window.showInputBox=async()=>answers.shift();await h.commands.create("comment");
 const created=h.sent[0];assert.equal(created.collaboration.type,"comment");assert.deepEqual(created.collaboration.anchor,{path:"src/a.ts",workspaceHost:"alice",startLine:2,endLine:3,sha256:digestCode("first\nsecond\nthird")});
 s.context=[{...record(),...created,id:"context_abc",authorHandle:"alice",version:1}];
 const choices=["Assign human owner",{label:"@bob",handle:"bob"}];vscode.window.showQuickPick=async()=>choices.shift();await h.commands.edit("context_abc");
 assert.equal(h.sent[1].collaboration.type,"task");assert.equal(h.sent[1].collaboration.assigneeHandle,"bob");assert.deepEqual(h.sent[1].collaboration.anchor,created.collaboration.anchor);
 vscode.window.activeTextEditor=undefined;
});
test("native anchor navigation opens the exact shared URI and refuses changed content",async()=>{
 const s=snapshot();const item=record();item.collaboration.anchor={path:"src/a.ts",workspaceHost:"alice",startLine:2,endLine:3,sha256:digestCode("first\nsecond\nthird")};s.context=[item];const h=harness(s);
 let text="first\nsecond\nthird";let opened=0;let seenUri;let revealed;
 vscode.Selection=class{constructor(start,end){this.start=start;this.end=end;}};
 vscode.workspace.openTextDocument=async uri=>{seenUri=uri;return {getText:()=>text,lineCount:3,lineAt:i=>({text:text.split("\n")[i]})};};
 const editor={revealRange:r=>revealed=r};vscode.window.showTextDocument=async()=>{opened++;return editor;};
 await h.commands.open("context_abc");assert.equal(seenUri.toString(),"file:///shared/src/a.ts");assert.equal(opened,1);assert.equal(editor.selection.start.line,1);assert.equal(revealed.end.line,2);
 text="modified";await h.commands.open("context_abc");assert.equal(opened,1);assert.match(h.warnings.at(-1),/stale/);
 s.host="bob";await h.commands.open("context_abc");assert.equal(opened,1);assert.match(h.warnings.at(-1),/different/);
});
