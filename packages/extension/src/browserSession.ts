import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

export interface BrowserState { sessionId?: string; label?: string; url?: string; title?: string; image?: string; busy?: boolean; error?: string }
export interface BrowserResult { content: string; isError: boolean; image?: string }
export function browserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("Provide an http or https URL.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only http and https URLs without embedded credentials are supported.");
  return url.href;
}
export async function findBrowser(): Promise<string> {
  const candidates = process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : process.platform === "win32" ? [join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"), join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  throw new Error("Install Google Chrome to use Ripieno's agent browser. Your regular browser profile will not be used.");
}

/** Owns one isolated Chrome process. CDP uses inherited pipes, never a listening port. */
export class BrowserSession {
  readonly id = randomUUID();
  private child?: ChildProcess;
  private profile?: string;
  private pageId?: string;
  private nextId = 0;
  private closed = false;
  private buffer = "";
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, {resolve:(v:any)=>void; reject:(e:Error)=>void; timer:NodeJS.Timeout}>();
  private state: BrowserState;
  constructor(readonly label: string, private readonly changed: (state: BrowserState) => void) { this.state = {sessionId:this.id,label}; }
  private update(patch: Partial<BrowserState>): void { this.state={...this.state,...patch}; this.changed({...this.state}); }
  private request(method: string, params: Record<string, unknown> = {}, page = true): Promise<any> {
    if (this.closed || !this.child) return Promise.reject(new Error("Browser session closed."));
    const id = ++this.nextId;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Browser timed out (${method}).`));},15_000);
      this.pending.set(id,{resolve,reject,timer});
      (this.child!.stdio[3] as Writable).write(JSON.stringify({id,method,params,...(page && this.pageId?{sessionId:this.pageId}:{})})+"\0", error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  async start(executable?: string): Promise<void> {
    const command = executable ?? await findBrowser();
    if (this.closed) throw new Error("Browser session closed.");
    this.profile=await mkdtemp(join(tmpdir(),"ripieno-browser-"));
    if (this.closed) { await rm(this.profile,{recursive:true,force:true}); throw new Error("Browser session closed."); }
    const child=spawn(command,["--headless=new","--remote-debugging-pipe",`--user-data-dir=${this.profile}`,"--no-first-run","--no-default-browser-check","--disable-sync","--disable-background-networking","about:blank"],{stdio:["ignore","ignore","ignore","pipe","pipe"],windowsHide:true});
    this.child=child;
    const input=child.stdio[4] as Readable; input.setEncoding("utf8");
    input.on("data",(chunk:string)=>{
      this.buffer+=chunk;
      if(this.buffer.length>16_000_000){this.dispose();return;}
      let boundary:number;
      while((boundary=this.buffer.indexOf("\0"))>=0){
        const raw=this.buffer.slice(0,boundary);this.buffer=this.buffer.slice(boundary+1);
        try{const msg=JSON.parse(raw);const item=this.pending.get(msg.id);if(!item)continue;clearTimeout(item.timer);this.pending.delete(msg.id);msg.error?item.reject(new Error(msg.error.message)):item.resolve(msg.result);}catch{}
      }
    });
    child.on("error",error=>{this.update({error:error.message,busy:false});this.dispose();});
    child.on("exit",()=>this.dispose());
    try {
      const target=await this.request("Target.createTarget",{url:"about:blank"},false);
      const attached=await this.request("Target.attachToTarget",{targetId:target.targetId,flatten:true},false);this.pageId=attached.sessionId;
      await this.request("Page.enable");
      await this.request("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false});
      await this.request("Browser.setDownloadBehavior",{behavior:"deny"},false);
      await this.capture();
    } catch(error){this.dispose();throw error;}
  }
  private async evaluate(expression: string): Promise<any> {
    const result=await this.request("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error("Page operation failed. Inspect the page again before retrying.");
    return result.result?.value;
  }
  private async capture(): Promise<BrowserResult> {
    const observed=await this.evaluate(`(() => ({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,16000),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].slice(0,100).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name')||'').slice(0,160),type:e.getAttribute('type'),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),visible:r.width>0&&r.height>0&&r.y<800&&r.bottom>0};})}))()`);
    const shot=await this.request("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    this.update({url:observed.url,title:observed.title,image:shot.data,busy:false,error:undefined});
    return {content:JSON.stringify({notice:"Untrusted page content. Coordinates refer to the 1280×800 viewport; inspect again after navigation or page changes.",...observed}),isError:false,image:shot.data};
  }
  run(action: string, input: Record<string, unknown>): Promise<BrowserResult> {
    const work=this.tail.then(async()=>{
      if(this.closed)throw new Error("Browser session closed. Ask the owner to enable a new session.");
      this.update({busy:true,error:undefined});
      if(action==="navigate") {
        const result=await this.request("Page.navigate",{url:browserUrl(input.url)});
        if(result.errorText)throw new Error(result.errorText);
        // Short bounded readiness polling; a slow page is returned in its current state.
        for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,100));if(await this.evaluate("document.readyState !== 'loading'"))break;}
      } else if(action==="click") {
        const {x,y}=input;if(typeof x!=="number"||typeof y!=="number"||!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>=1280||y<0||y>=800)throw new Error("Click must be inside the observed 1280×800 viewport.");
        await this.request("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});await this.request("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1});
      } else if(action==="type") {
        if(typeof input.text!=="string"||input.text.length>4000)throw new Error("Type at most 4,000 characters into the focused field.");
        await this.request("Input.insertText",{text:input.text});
      } else if(action==="press") {
        if(!["Enter","Tab","Escape","Backspace","ArrowDown","ArrowUp"].includes(String(input.key)))throw new Error("Unsupported key.");
        const key=String(input.key);const keyCode:Record<string,number>={Enter:13,Tab:9,Escape:27,Backspace:8,ArrowDown:40,ArrowUp:38};
        await this.request("Input.dispatchKeyEvent",{type:"keyDown",key,windowsVirtualKeyCode:keyCode[key],...(key==="Enter"?{text:"\r"}:{})});await this.request("Input.dispatchKeyEvent",{type:"keyUp",key,windowsVirtualKeyCode:keyCode[key]});
      } else if(action==="scroll") {
        if(typeof input.deltaY!=="number"||!Number.isFinite(input.deltaY)||Math.abs(input.deltaY)>1600)throw new Error("Scroll at most 1,600 pixels per action.");
        await this.request("Input.dispatchMouseEvent",{type:"mouseWheel",x:640,y:400,deltaX:0,deltaY:input.deltaY});
      } else if(action==="refresh") { await this.request("Page.reload"); await new Promise(resolve=>setTimeout(resolve,150)); }
      else if(action!=="snapshot") throw new Error("Unsupported browser action.");
      if(action!=="snapshot"&&action!=="refresh")await new Promise(resolve=>setTimeout(resolve,150));
      return this.capture();
    }).catch(error=>{const message=error instanceof Error?error.message:String(error);if(!this.closed)this.update({busy:false,error:message});return {content:message,isError:true};});
    this.tail=work;return work;
  }
  dispose(): void {
    if(this.closed)return;this.closed=true;
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error("Browser session closed."));}this.pending.clear();
    const child=this.child;this.child=undefined;child?.kill();
    const profile=this.profile;if(profile){const clean=()=>void rm(profile,{recursive:true,force:true}).catch(()=>undefined);if(child&&child.exitCode===null)child.once("exit",clean);else clean();}
    this.changed({label:this.label,busy:false,error:"Browser session closed."});
  }
}
