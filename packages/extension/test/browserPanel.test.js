const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const {buildSync}=require('esbuild');
// Exercise the real webview message boundary without opening an editor.
const bundle=buildSync({entryPoints:[path.join(__dirname,'../src/roomView.ts')],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']}).outputFiles[0].text;
const loaded=new Module(path.join(__dirname,'browser-panel-bundle.cjs'),module);
loaded.filename=path.join(__dirname,'browser-panel-bundle.cjs');
loaded.paths=module.paths;
loaded.require=name=>name==='vscode'?{}:require(name);
loaded._compile(bundle,loaded.filename);
const {RoomViewProvider}=loaded.exports;
function panel(){const p=new RoomViewProvider({},()=>{});const calls=[];p.setBrowserHandler(msg=>calls.push(msg));p.setBrowserState({sessionId:'current',busy:false});return {p,calls};}
test('browser UI refuses wrong sessions, extra fields, invalid coordinates and arbitrary actions',()=>{
 const {p,calls}=panel();
 for(const msg of [{type:'browserAction',sessionId:'old',action:'close'},{type:'browserAction',sessionId:'current',action:'click',x:0,y:0,url:'https://example.com'},{type:'browserAction',sessionId:'current',action:'click',x:1280,y:0},{type:'browserAction',sessionId:'current',action:'evaluate',code:'anything'},{type:'browserAction',sessionId:'current',action:'scroll',deltaY:2000}])p.handleBrowserMessage(msg);
 assert.equal(calls.length,0);
 p.handleBrowserMessage({type:'browserAction',sessionId:'current',action:'click',x:100,y:100});assert.equal(calls.length,1);
});
test('Stop remains available while browser is busy; other UI actions wait',()=>{
 const {p,calls}=panel();p.setBrowserState({sessionId:'current',busy:true});
 p.handleBrowserMessage({type:'browserAction',sessionId:'current',action:'type',text:'blocked'});
 p.handleBrowserMessage({type:'browserAction',sessionId:'current',action:'close'});
 assert.deepEqual(calls.map(call=>call.action),['close']);
});
