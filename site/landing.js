(() => {
  'use strict';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const graph = document.getElementById('network');
  const canvas = document.getElementById('network-canvas');
  const ctx = canvas.getContext('2d');
  const motionButton = document.getElementById('motion-toggle');
  let paused = reduced.matches, visible = true, width = 0, height = 0, frame = 0, last = 0;
  let pointer = null, activeDrag = null, selected = 'room', lastInteraction = 0, lastAutoPulse = 0;
  const particles = [], pulses = [];
  const content = {
    room: ['01 / 06', 'A place for all the moving parts.', 'One conversation connects your team, their agents, and the work in front of you.'],
    you: ['02 / 06', 'You stay in the conversation.', 'Bring an idea, steer an agent, or take over the browser. It is still your workspace.'],
    claude: ['03 / 06', 'Your agent joins the team.', 'Bring Claude Code into the room with its own tools, permissions, and visible activity.'],
    browser: ['04 / 06', 'Look at the same thing.', 'Explore the same in-editor browser page as your agent, with a direct handover of control.'],
    codex: ['05 / 06', 'Different agents. Shared direction.', 'Connect Codex alongside your other agents. Each provider keeps its own capabilities and controls.'],
    context: ['06 / 06', 'Keep the useful bits together.', 'Save decisions, notes, and references in shared room context. Give the next task a better starting point.']
  };
  const nodes = [...graph.querySelectorAll('[data-node]')].map(el => ({
    el, id: el.dataset.node, x: Number(el.style.getPropertyValue('--x')) / 100, y: Number(el.style.getPropertyValue('--y')) / 100
  }));
  const links = [[0,1],[0,2],[0,3],[0,4],[0,5],[1,5],[2,3],[3,4],[4,5]];
  function updateMotionLabel() {
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.textContent = paused ? 'Resume motion ▷' : 'Pause motion Ⅱ';
  }
  function nodePoint(node) {
    // Position connections on the node's circular body, above its text label.
    return { x: node.x * width, y: node.y * height - 11 };
  }
  function selectNode(id) {
    selected = id;
    const [index,title,description] = content[id];
    document.getElementById('node-index').textContent = index;
    document.getElementById('node-title').textContent = title;
    document.getElementById('node-description').textContent = description;
    nodes.forEach(node => node.el.setAttribute('aria-pressed', String(node.id === id)));
    sendPulse(nodes.findIndex(node => node.id === id));
  }
  function sendPulse(index = 0) {
    if (!paused) {
      links.forEach(([a,b]) => { if (a === index || b === index) pulses.push({ a: index, b: a === index ? b : a, p: 0 }); });
      if (pulses.length > 32) pulses.splice(0,pulses.length-32);
    }
    render(performance.now(),0);
    schedule();
  }
  nodes.forEach(node => {
    node.el.addEventListener('click', event => {
      if (node.suppressClick) { node.suppressClick = false; return; }
      selectNode(node.id);
    });
    node.el.addEventListener('pointerdown',event => {
      if (event.button !== 0 || !event.isPrimary) return;
      activeDrag = { node, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved:false };
      node.el.setPointerCapture(event.pointerId);
      lastInteraction = performance.now();
    });
    node.el.addEventListener('pointermove',event => {
      if (!activeDrag || activeDrag.node !== node || activeDrag.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX-activeDrag.startX,event.clientY-activeDrag.startY)>5) activeDrag.moved=true;
      if (!activeDrag.moved) return;
      const rect=graph.getBoundingClientRect();
      node.x=Math.max(.12,Math.min(.88,(event.clientX-rect.left)/width));
      node.y=Math.max(.15,Math.min(.83,(event.clientY-rect.top)/height));
      node.el.style.setProperty('--x',node.x*100); node.el.style.setProperty('--y',node.y*100);
      render(performance.now(),0);
    });
    const endDrag=event=>{
      if (!activeDrag || activeDrag.pointerId!==event.pointerId || activeDrag.node!==node) return;
      node.suppressClick=activeDrag.moved;
      const moved=activeDrag.moved; activeDrag=null;
      if(node.el.hasPointerCapture(event.pointerId))node.el.releasePointerCapture(event.pointerId);
      if(moved)selectNode(node.id);
    };
    node.el.addEventListener('pointerup',endDrag);
    node.el.addEventListener('pointercancel',endDrag);
    node.el.addEventListener('lostpointercapture',endDrag);
  });
  graph.addEventListener('pointermove',event=>{const r=graph.getBoundingClientRect();pointer={x:event.clientX-r.left,y:event.clientY-r.top};lastInteraction=performance.now();schedule();});
  graph.addEventListener('pointerleave',()=>{pointer=null;});
  graph.addEventListener('click',event=>{
    if(event.target.closest('button'))return;
    const r=graph.getBoundingClientRect(); const point={x:event.clientX-r.left,y:event.clientY-r.top};
    let nearest=0,distance=Infinity;
    nodes.forEach((node,index)=>{const p=nodePoint(node);const d=Math.hypot(point.x-p.x,point.y-p.y);if(d<distance){distance=d;nearest=index;}});
    selectNode(nodes[nearest].id);
  });
  document.getElementById('network-pulse').addEventListener('click',()=>{
    const next=(nodes.findIndex(node=>node.id===selected)+1)%nodes.length;
    selectNode(nodes[next].id);
  });
  function resize() {
    const r=graph.getBoundingClientRect();width=r.width;height=r.height;
    const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    ctx?.setTransform(dpr,0,0,dpr,0,0);
    particles.length=0;
    // A bounded grid rather than an unbounded particle simulation.
    const spacing=26;
    for(let y=14;y<height;y+=spacing)for(let x=12;x<width;x+=spacing)particles.push({x,y,dx:0,dy:0});
    render(performance.now(),0);schedule();
  }
  function render(now,dt) {
    if(!ctx||!width)return;
    ctx.clearRect(0,0,width,height);
    for(const p of particles){
      let tx=0,ty=0,near=0;
      if(pointer&&!paused){const dx=p.x-pointer.x,dy=p.y-pointer.y;const dist=Math.hypot(dx,dy);if(dist<95){near=1-dist/95;tx=(dx/(dist||1))*near*12;ty=(dy/(dist||1))*near*12;}}
      p.dx=paused?0:p.dx+(tx-p.dx)*.13;p.dy=paused?0:p.dy+(ty-p.dy)*.13;
      ctx.beginPath();ctx.arc(p.x+p.dx,p.y+p.dy,near>0?1+near:0.7,0,Math.PI*2);ctx.fillStyle=near>0?`rgba(217,249,136,${.25+near*.4})`:'rgba(157,179,214,.20)';ctx.fill();
      if(near>.55){ctx.beginPath();ctx.moveTo(p.x+p.dx,p.y+p.dy);ctx.lineTo(pointer.x,pointer.y);ctx.strokeStyle=`rgba(217,249,136,${near*.1})`;ctx.lineWidth=.65;ctx.stroke();}
    }
    links.forEach(([a,b])=>{
      const p=nodePoint(nodes[a]),q=nodePoint(nodes[b]); const active=nodes[a].id===selected||nodes[b].id===selected;
      ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.lineWidth=active?1.15:.8;ctx.strokeStyle=active?'rgba(217,249,136,.46)':'rgba(157,179,214,.25)';ctx.setLineDash(a===0?[]:[3,6]);ctx.stroke();ctx.setLineDash([]);
    });
    if(!paused){
      for(let i=pulses.length-1;i>=0;i--){const pulse=pulses[i];pulse.p+=dt/1400;if(pulse.p>=1){pulses.splice(i,1);continue;}const a=nodePoint(nodes[pulse.a]),b=nodePoint(nodes[pulse.b]),x=a.x+(b.x-a.x)*pulse.p,y=a.y+(b.y-a.y)*pulse.p;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fillStyle='#d9f988';ctx.fill();ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fillStyle='#d9f98815';ctx.fill();}
      if(now-lastAutoPulse>3200 && now-lastInteraction>2200){lastAutoPulse=now;links.slice(0,5).forEach(([a,b])=>pulses.push({a,b,p:0}));}
    }
  }
  function tick(now){frame=0;if(paused||!visible||document.hidden)return;const dt=Math.min(now-last||16,40);last=now;render(now,dt);schedule();}
  function schedule(){if(!frame&&!paused&&visible&&!document.hidden)frame=requestAnimationFrame(tick);}
  function stopFrame(){cancelAnimationFrame(frame);frame=0;last=0;}
  motionButton.addEventListener('click',()=>{paused=!paused;updateMotionLabel();stopFrame();render(performance.now(),0);schedule();});
  reduced.addEventListener('change',event=>{paused=event.matches;updateMotionLabel();stopFrame();render(performance.now(),0);schedule();});
  document.addEventListener('visibilitychange',()=>{stopFrame();schedule();});
  if('IntersectionObserver' in window)new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;stopFrame();schedule();},{rootMargin:'60px'}).observe(graph);
  if('ResizeObserver' in window)new ResizeObserver(resize).observe(graph);else window.addEventListener('resize',resize);
  updateMotionLabel();resize();

})();

(() => {
const stages={review:{prompt:'Review this homepage copy for clarity and usability. Bring me a plan.',reply:'Two reviewers have the same brief. Their findings stay attached to this conversation.',detail:'<h3>Reviewers <span class="tag">2 reports</span></h3><div class="agentrow"><div>Clarity review<small>Sample reviewer A</small></div><span class="green">Done</span></div><div class="agentrow"><div>Usability review<small>Sample reviewer B</small></div><span class="green">Done</span></div>',report:'<strong class="green">A common next step</strong><p>Make the setup path explicit. Show what the product does before asking someone to install it.</p>'},browser:{prompt:'Open the preview so we can inspect the same page.',reply:'The page and the conversation belong together. A visible control handover keeps the next action clear.',detail:'<h3>Browser <span class="tag">Illustration</span></h3><div class="browsermock"><small>localhost / project</small><h4>A little more<br>room to think.</h4><button id="sample-accent">Try sample accent</button></div>',report:'<strong class="green">You have control</strong><p>One visible page for you and your agent, with a handover when you want to take the lead.</p>'},context:{prompt:'Keep the decision: one clear setup action, and a real product walkthrough.',reply:'Save useful decisions where the next task can find them. Review agent suggestions before accepting them.',detail:'<h3>Shared decisions</h3><div class="agentrow"><div>Show the product first<small>Example note · accepted by you</small></div></div><div class="agentrow"><div>Explain the preview setup<small>Example note · accepted by you</small></div></div>',report:'<strong class="green">Less context to repeat</strong><p>Notes, decisions, and references stay attached to the room.</p>'}};
function stage(id){document.querySelectorAll('[data-stage]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.stage===id)));let s=stages[id];document.getElementById('a-prompt').textContent=s.prompt;document.getElementById('a-reply').textContent=s.reply;document.getElementById('a-detail').innerHTML=s.detail;document.getElementById('a-report').innerHTML=s.report;const accent=document.getElementById('sample-accent');if(accent)accent.onclick=()=>{accent.parentElement.style.background=accent.parentElement.style.background?'':'#dce2fa';};}
document.querySelectorAll('[data-stage]').forEach(x=>x.onclick=()=>stage(x.dataset.stage));stage('review');

})();
