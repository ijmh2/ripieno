const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {BrowserSession,browserUrl}=require('../dist/browserSession');
const {codexBrowserArgs,BROWSER_TOOLS}=require('../dist/browserTools');

test('browser navigation rejects local files, executable URLs and embedded credentials',()=>{
  for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,hello','https://user:secret@example.com/'])assert.throws(()=>browserUrl(url));
  assert.equal(browserUrl('http://127.0.0.1:8000/path'),'http://127.0.0.1:8000/path');
  assert.equal(browserUrl('https://example.com'),'https://example.com/');
});
test('Codex browser config scopes the bridge to browser tools without changing global permissions',()=>{
  const args=codexBrowserArgs('/app/node','/app/browser.js','ws://127.0.0.1:4321','token');
  assert.ok(args.includes('mcp_servers.ripieno_browser.command="/app/node"'));
  const tools=args.find(arg=>arg.startsWith('mcp_servers.ripieno_browser.enabled_tools='));
  assert.deepEqual(JSON.parse(tools.split('=').slice(1).join('=')),BROWSER_TOOLS.map(tool=>tool.name));
  assert.ok(!args.some(arg=>/sandbox|approval_policy|bypass/.test(arg)));
});
test('closed browser refuses queued work without starting a process',async()=>{
  const states=[];const browser=new BrowserSession('test',state=>states.push(state));browser.dispose();
  const result=await browser.run('navigate',{url:'https://example.com'});
  assert.equal(result.isError,true);assert.match(result.content,/closed/);assert.equal(states.at(-1).sessionId,undefined);
});
test('isolated Chrome can inspect, click, type and stop on a local page',{skip:process.env.LIVE_RIPIENO_BROWSER!=='1',timeout:30000},async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Ripieno browser probe</title><h1>Local test</h1><input aria-label="Message" oninput="document.querySelector('h1').textContent=this.value"><button onclick="document.querySelector('h1').textContent='Clicked'">Change heading</button>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const states=[];const browser=new BrowserSession('Probe agent',state=>states.push(state));
  try {
    await browser.start();
    const opened=await browser.run('navigate',{url:`http://127.0.0.1:${server.address().port}`});assert.equal(opened.isError,false,opened.content);assert.ok(opened.image.length>100);
    const page=JSON.parse(opened.content);assert.equal(page.title,'Ripieno browser probe');
    const input=page.elements.find(e=>e.label==='Message');assert.ok(input);
    await browser.run('click',{x:input.x,y:input.y});
    const typed=await browser.run('type',{text:'Ripieno'});assert.equal(typed.isError,false);assert.match(JSON.parse(typed.content).text,/Ripieno/);
    const button=page.elements.find(e=>e.tag==='button');await browser.run('click',{x:button.x,y:button.y});
    const after=await browser.run('snapshot',{});assert.match(JSON.parse(after.content).text,/Clicked/);
    const rejected=await browser.run('navigate',{url:'file:///etc/passwd'});assert.equal(rejected.isError,true);
    browser.dispose();assert.equal((await browser.run('click',{x:10,y:10})).isError,true);
  } finally {browser.dispose();await new Promise(resolve=>server.close(resolve));}
});
