// Gemlight Keep server: serves index.html, runs online rooms (relay + host-authoritative world),
// validates movement / Shadow Step / pickups / boss fights / level clears, and owns profiles + points.
// Usage: npm install && node server.js
// Env: PORT (8080) · GK_DEV=1 enables ?dev=1 point grants (off by default) · GK_DAILY_CAP (600) · GK_DATA (./data/profiles.json) · GK_REG_LIMIT (5 new profiles/IP/hour)
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const {WebSocketServer}=require('ws');
const FILE=path.join(__dirname,'index.html');
const src=fs.readFileSync(FILE,'utf8'),sm=src.match(/<script id="shared">([\s\S]*?)<\/script>/);
const ctx={};ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(sm[1],ctx);const GK=ctx.GK,T=GK.TILE;
const CFG={port:+process.env.PORT||8080,dev:process.env.GK_DEV==='1',dailyCap:+process.env.GK_DAILY_CAP||GK.POINTS.dailyCap,
  data:process.env.GK_DATA||path.join(__dirname,'data','profiles.json'),tz:'America/Los_Angeles',regLimit:+process.env.GK_REG_LIMIT||5};
// ---------------- profile store (JSON file) ----------------
let DB={profiles:{}};try{DB=JSON.parse(fs.readFileSync(CFG.data,'utf8'));if(!DB.profiles)DB.profiles={};}catch(e){}
let saveTimer=null;
function flush(){try{fs.mkdirSync(path.dirname(CFG.data),{recursive:true});const tmp=CFG.data+'.tmp';fs.writeFileSync(tmp,JSON.stringify(DB,null,1));fs.renameSync(tmp,CFG.data);}catch(e){console.error('save failed',e.message);}}
function persist(){if(saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;flush();},250);}
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{flush();process.exit(0);});
const dayKey=()=>new Intl.DateTimeFormat('en-CA',{timeZone:CFG.tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const byNick=n=>Object.values(DB.profiles).find(p=>p.nick.toLowerCase()===String(n).toLowerCase());
function rollDay(p){const d=dayKey();if(p.day!==d){p.day=d;p.dayEarned=0;}}
function pub(p){rollDay(p);return{pid:p.pid,nick:p.nick,points:p.points,lifetime:p.lifetime,unlockedChars:p.chars,unlockedLevels:p.levels,dayEarned:p.dayEarned,cap:CFG.dailyCap,day:p.day,hasPin:!!p.pinHash,recent:(p.log||[]).slice(-5)};}
function grant(p,ev,pts){rollDay(p);const g=Math.max(0,Math.min(pts,CFG.dailyCap-p.dayEarned));p.dayEarned+=g;p.points+=g;p.lifetime+=g;
  p.log=(p.log||[]).slice(-49);p.log.push({t:Date.now(),ev,pts,granted:g});persist();return g;}
const hashPin=(pin,salt)=>crypto.scryptSync(String(pin),salt,32).toString('hex');
function pinOk(p,pin){if(!p.pinHash)return false;const a=Buffer.from(hashPin(pin,p.salt),'hex'),b=Buffer.from(p.pinHash,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b);}
const NICK=/^[A-Za-z0-9 _-]{3,12}$/,PIN=/^\d{4,8}$/;
const charOk=(p,i)=>GK.CHARS[i]&&(GK.CHARS[i].cost===0||(p&&p.chars.indexOf(i)>=0));
const levelOk=(p,n)=>n===1||(p&&p.levels.indexOf(n)>=0);
// ---------------- rate limits ----------------
const hits=new Map();
function allow(key,max,ms){const t=Date.now(),a=(hits.get(key)||[]).filter(x=>t-x<ms);if(a.length>=max){hits.set(key,a);return false;}a.push(t);hits.set(key,a);return true;}
setInterval(()=>{const t=Date.now();for(const [k,a] of hits)if(!a.length||t-a[a.length-1]>3600e3)hits.delete(k);},60e3).unref();
// ---------------- http ----------------
const server=http.createServer((req,res)=>{const u=req.url.split('?')[0];
  if(u==='/'||u==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(FILE));}
  else if(u==='/favicon.ico'){res.writeHead(204);res.end();}
  else if(u==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size,dev:CFG.dev,dailyCap:CFG.dailyCap}));}
  else{res.writeHead(404);res.end('not found');}});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:32*1024});
const rooms=new Map();let nextId=1;const LET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode(){let c;do{c='';for(let i=0;i<4;i++)c+=LET[Math.floor(Math.random()*LET.length)];}while(rooms.has(c));return c;}
const send=(ws,o)=>{if(ws.readyState===1)ws.send(JSON.stringify(o));};
const roster=r=>[...r.players.values()].map(p=>({id:p.id,slot:p.slot,name:p.name,char:p.char,host:p.id===r.host,guest:!p.profile}));
const bcast=(r,o,except)=>{const s=JSON.stringify(o);for(const p of r.players.values())if(p.id!==except&&p.ws.readyState===1)p.ws.send(s);};
const now=()=>Date.now()/1000;
const stats={stRejected:0,stepOk:0,stepRejected:0,tpRejected:0,pickRejected:0,openRejected:0,clearsValid:0,clearsInvalid:0,bossHits:0,rateDropped:0};
function setLevel(r,n){r.levelN=n;r.L=n<=GK.LEVEL_COUNT?GK.genLevel(n):null;r.opened=new Set();r.levelT=now();r.keyOk=false;r.cpReached=new Set();
  r.tally={};r.picked=new Set();r.plateT={};r.awarded=false;
  r.boss=r.L&&r.L.boss?{hp:r.L.boss.hp,max:r.L.boss.hp,active:false,t0:0,dead:false}:null;
  for(const p of r.players.values())resetPos(r,p);}
function resetPos(r,p){const s=r.L?GK.spawnFor(r.L,p.slot):{x:0,y:0};p.pos={x:s.x,y:s.y};p.bx=p.capX();p.by=1200;p.t=now();p.grace=now()+0.5;}
const inside=(r,x,y)=>GK.boxHits(r.L,r.opened,x+3,y+3,GK.PW-6,GK.PH-6,false);
const center=p=>({x:p.pos.x+GK.PW/2,y:p.pos.y+GK.PH/2});
function bossMsg(r){const b=r.boss;return{t:'boss',hp:b.hp,max:b.max,active:b.active?1:0,dead:b.dead?1:0,el:b.active?+(now()-b.t0).toFixed(3):0};}
function award(r,items){if(!items.length)return;bcast(r,{t:'awards',items});
  const seen=new Set();for(const it of items){const p=r.players.get(it.id);if(p&&p.profile&&!seen.has(p.id)){seen.add(p.id);send(p.ws,{t:'profile',profile:pub(p.profile)});}}}
function awardAll(r,ev,pts){const out=[];for(const p of r.players.values()){if(!p.profile)continue;out.push({id:p.id,nick:p.name,ev,pts,granted:grant(p.profile,ev,pts)});}return out;}
function validTp(r,who,x,y){const ok=(a,b,tol)=>Math.abs(a-x)<=tol&&Math.abs(b-y)<=tol;
  if(ok(who.pos.x,who.pos.y,8))return true;
  for(let s=0;s<4;s++){const sp=GK.spawnFor(r.L,s);if(ok(sp.x,sp.y,40))return true;}
  for(const i of r.cpReached){const c=r.L.checkpoints[i];if(ok(c.x-GK.PW/2,c.y-GK.PH,120))return true;}
  for(const q of r.players.values())if(q!==who&&ok(q.pos.x,q.pos.y,64))return true;return false;}
function platesHeld(r){const t=now(),ids=r.L.plates.map(p=>p.id),held=ids.filter(i=>t-(r.plateT[i]||-9)<1.5);return r.players.size<2?held.length>0:held.length===ids.length;}
function leaveRoom(me){const r=me.room;if(!r)return;me.room=null;r.players.delete(me.id);
  if(r.host===me.id){bcast(r,{t:'closed'});rooms.delete(r.code);for(const p of r.players.values())p.room=null;}
  else{bcast(r,{t:'left',id:me.id});bcast(r,{t:'lobby',players:roster(r)});}
  if(!r.players.size)rooms.delete(r.code);}
wss.on('connection',(ws,req)=>{const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const me={id:'u'+(nextId++),ws,room:null,char:0,slot:0,name:'Guest',stepT:-99,atkT:-99,profile:null,tokens:150,tokT:Date.now(),drops:0};
  me.capX=()=>GK.CHARS[me.char].speed*0.9+60;
  send(ws,{t:'cfg',dev:CFG.dev,dailyCap:CFG.dailyCap});
  ws.on('message',raw=>{const tn=Date.now();me.tokens=Math.min(150,me.tokens+(tn-me.tokT)*0.08);me.tokT=tn; // ~80 msgs/s sustained, burst 150
    if(me.tokens<1){stats.rateDropped++;if(++me.drops>600)ws.close(1008,'rate limit');return;}me.tokens--;
    let msg;try{msg=JSON.parse(raw);}catch(e){return;}if(!msg||typeof msg.t!=='string')return;const r=me.room;
    try{handle(me,r,msg,ip);}catch(e){console.error('handler error',e);}});
  ws.on('close',()=>leaveRoom(me));});
function handle(me,r,msg,ip){const ws=me.ws;switch(msg.t){
  // ----- profiles -----
  case 'hello':{const p=DB.profiles[String(msg.pid||'')];if(!allow('hello:'+ip,30,60e3))return send(ws,{t:'err',msg:'Too many requests, slow down'});
    if(p){me.profile=p;me.name=p.nick;send(ws,{t:'profile',profile:pub(p)});}else send(ws,{t:'noprofile'});break;}
  case 'register':{const nick=String(msg.nick||'').trim(),pin=msg.pin?String(msg.pin):'';
    if(!NICK.test(nick))return send(ws,{t:'err',msg:'Nickname: 3-12 letters, numbers, space, _ or -'});
    if(pin&&!PIN.test(pin))return send(ws,{t:'err',msg:'PIN must be 4-8 digits'});
    if(byNick(nick))return send(ws,{t:'err',msg:'That nickname is taken (reclaim it with its PIN)'});
    if(!allow('reg:'+ip,CFG.regLimit,3600e3))return send(ws,{t:'err',msg:'Profile limit reached for now, try later'});
    const pid=crypto.randomBytes(12).toString('base64url'),salt=crypto.randomBytes(12).toString('hex');
    const p={pid,nick,salt,pinHash:pin?hashPin(pin,salt):null,created:Date.now(),points:0,lifetime:0,chars:[],levels:[1],day:dayKey(),dayEarned:0,log:[]};
    DB.profiles[pid]=p;persist();me.profile=p;me.name=nick;send(ws,{t:'profile',profile:pub(p),created:1});break;}
  case 'reclaim':{const nick=String(msg.nick||''),p=byNick(nick);
    if(!allow('rec:'+ip,5,900e3)||!allow('recn:'+nick.toLowerCase(),8,900e3))return send(ws,{t:'err',msg:'Too many reclaim attempts, wait 15 minutes'});
    if(!p||!pinOk(p,msg.pin))return send(ws,{t:'err',msg:'Nickname or PIN is wrong (profiles without a PIN cannot be reclaimed)'});
    me.profile=p;me.name=p.nick;send(ws,{t:'profile',profile:pub(p),reclaimed:1});break;}
  case 'setpin':{if(!me.profile)return;const pin=String(msg.pin||'');if(!PIN.test(pin))return send(ws,{t:'err',msg:'PIN must be 4-8 digits'});
    if(!allow('pin:'+me.profile.pid,5,3600e3))return send(ws,{t:'err',msg:'Too many PIN changes'});
    me.profile.pinHash=hashPin(pin,me.profile.salt);persist();send(ws,{t:'profile',profile:pub(me.profile),pinset:1});break;}
  case 'unlock':{const p=me.profile;if(!p)return send(ws,{t:'err',msg:'Create a profile first'});if(!allow('unl:'+p.pid,10,10e3))return send(ws,{t:'err',msg:'Slow down'});
    if(msg.kind==='char'){const i=msg.id|0,ch=GK.CHARS[i];if(!ch)return;if(charOk(p,i))return send(ws,{t:'err',msg:'Already unlocked'});
      if(p.points<ch.cost)return send(ws,{t:'err',msg:'Need '+(ch.cost-p.points)+' more points'});p.points-=ch.cost;p.chars.push(i);}
    else if(msg.kind==='level'){const n=msg.id|0;if(n<2||n>GK.LEVEL_COUNT)return;if(levelOk(p,n))return send(ws,{t:'err',msg:'Already unlocked'});
      if(!levelOk(p,n-1))return send(ws,{t:'err',msg:'Unlock level '+(n-1)+' first'});const c=GK.levelCost(n);
      if(p.points<c)return send(ws,{t:'err',msg:'Need '+(c-p.points)+' more points'});p.points-=c;p.levels.push(n);p.levels.sort((a,b)=>a-b);}
    else return;p.log=(p.log||[]).slice(-49);p.log.push({t:Date.now(),ev:'unlock '+msg.kind+' '+msg.id});persist();send(ws,{t:'profile',profile:pub(p),unlocked:1});break;}
  case 'dev':{if(!CFG.dev||!me.profile)return send(ws,{t:'err',msg:'Dev mode is disabled on this server'});me.profile.points+=99999;persist();send(ws,{t:'profile',profile:pub(me.profile)});break;}
  // ----- rooms -----
  case 'host':{if(r)return;if(!allow('host:'+ip,10,60e3))return send(ws,{t:'err',msg:'Too many rooms, wait a minute'});
    const c=newCode(),room={code:c,host:me.id,players:new Map(),started:false,L:null,opened:new Set()};rooms.set(c,room);
    if(!me.profile)me.name=String(msg.name||'Guest').slice(0,12);me.char=charOk(me.profile,msg.char|0)?msg.char|0:0;me.slot=0;me.room=room;room.players.set(me.id,me);
    send(ws,{t:'hosted',code:c,id:me.id,players:roster(room)});break;}
  case 'join':{if(r)return;if(!allow('join:'+ip,20,60e3))return send(ws,{t:'err',msg:'Too many join attempts'});
    const room=rooms.get(String(msg.code||'').toUpperCase().trim());
    if(!room)return send(ws,{t:'err',msg:'No room with that code'});if(room.started)return send(ws,{t:'err',msg:'Game already started'});
    if(room.players.size>=4)return send(ws,{t:'err',msg:'Room is full (4 players)'});
    const used=new Set([...room.players.values()].map(p=>p.slot));let s=0;while(used.has(s))s++;
    if(!me.profile)me.name=String(msg.name||'Guest').slice(0,12);me.char=charOk(me.profile,msg.char|0)?msg.char|0:0;me.slot=s;me.room=room;room.players.set(me.id,me);
    send(ws,{t:'joined',code:room.code,id:me.id,players:roster(room)});bcast(room,{t:'lobby',players:roster(room)},me.id);break;}
  case 'leave':leaveRoom(me);break;
  case 'pick_char':{if(!r||r.started)return;const i=msg.char|0;if(!charOk(me.profile,i))return send(ws,{t:'err',msg:'Character is locked on your profile'});me.char=i;bcast(r,{t:'lobby',players:roster(r)});break;}
  case 'start':{if(!r||r.host!==me.id||r.started)return;const n=Math.max(1,Math.min(15,msg.level|0||1));
    if(!levelOk(me.profile,n))return send(ws,{t:'err',msg:'Level '+n+' is locked on the host profile'});
    r.started=true;setLevel(r,n);bcast(r,{t:'start',level:n,players:roster(r)});break;}
  case 'st':{if(!r||!r.L||!r.started)return;const x=+msg.x,y=+msg.y;if(!isFinite(x)||!isFinite(y))return;
    const t=now(),dt=Math.min(1,t-me.t);me.t=t;const ch=GK.CHARS[me.char];
    me.bx=Math.min(me.capX(),me.bx+ch.speed*1.35*dt);me.by=Math.min(1200,me.by+GK.MAXFALL*1.5*dt);
    const dx=Math.abs(x-me.pos.x),dy=Math.abs(y-me.pos.y);
    const ok=t<me.grace||(dx<=me.bx+24&&dy<=me.by+40&&x>=-4&&x<=r.L.w*T&&!inside(r,x,y));
    if(!ok){stats.stRejected++;send(ws,{t:'fix',x:me.pos.x,y:me.pos.y});return;}
    me.bx=Math.max(0,me.bx-dx);me.by=Math.max(0,me.by-dy);me.pos={x,y};
    r.L.checkpoints.forEach((c,i)=>{if(Math.abs(x+GK.PW/2-c.x)<40)r.cpReached.add(i);});
    for(const pl of r.L.plates)if(x+GK.PW>pl.tx*T+2&&x<pl.tx*T+30&&y+GK.PH>GK.GROUND*T-14&&y+GK.PH<=GK.GROUND*T+2)r.plateT[pl.id]=t;
    if(r.boss&&!r.boss.active&&x+GK.PW>=r.L.boss.x0){r.boss.active=true;r.boss.t0=t;bcast(r,bossMsg(r));}
    bcast(r,{t:'st',id:me.id,x,y,vx:msg.vx|0,vy:msg.vy|0,f:msg.f>0?1:-1,m:msg.m?1:0,a:msg.a?1:0,ih:msg.ih?1:0},me.id);break;}
  case 'step':{if(!r||!r.L)return;const t=now(),ch=GK.CHARS[me.char];const fx=+msg.fx,fy=+msg.fy,tx=+msg.tx,ty=+msg.ty;let why=null;
    if(ch.ability!=='shadow')why='character cannot Shadow Step';else if(t-me.stepT<GK.STEP.cd-0.2)why='cooldown';
    else if(![fx,fy,tx,ty].every(isFinite))why='bad numbers';else if(Math.hypot(fx-me.pos.x,fy-me.pos.y)>48)why='start position mismatch';
    else if(!GK.validateStep(r.L,r.opened,fx,fy,tx,ty))why='path or distance invalid';
    if(why){stats.stepRejected++;send(ws,{t:'stepno',x:me.pos.x,y:me.pos.y,why});return;}
    stats.stepOk++;me.stepT=t;me.pos={x:tx,y:ty};me.grace=0;send(ws,{t:'stepok'});bcast(r,{t:'step',id:me.id,fx,fy,tx,ty},me.id);break;}
  case 'atk':{if(!r||!r.L)return;const t=now();if(t-me.atkT<0.25)return;me.atkT=t;const f=msg.f>0?1:-1;
    const h=r.players.get(r.host);if(h&&h!==me)send(h.ws,{t:'ev',id:me.id,k:'atk'});
    const b=r.boss;if(b&&b.active&&!b.dead){const bp=GK.bossPos(r.L,t-b.t0),a=GK.atkBox(me.pos.x,me.pos.y,f);
      if(a.x<bp.x+GK.BOSS.w+6&&a.x+a.w>bp.x-6&&a.y<bp.y+GK.BOSS.h+6&&a.y+a.h>bp.y-6){stats.bossHits++;b.hp=Math.max(0,b.hp-GK.CHARS[me.char].atk);
        if(b.hp<=0){b.dead=true;bcast(r,bossMsg(r));award(r,awardAll(r,'boss kill L'+r.levelN,GK.POINTS.bossKill(r.levelN)));}else bcast(r,bossMsg(r));}}break;}
  case 'ev':{if(!r)return;if(msg.k==='atk')return;const h=r.players.get(r.host);if(h&&h!==me)send(h.ws,{t:'ev',id:me.id,k:String(msg.k)});break;}
  case 'pick':{if(!r||r.host!==me.id||!r.L)return;const by=r.players.get(msg.by);if(!by)return;const c=center(by);
    if(msg.kind==='gem'){const g=r.L.gems[msg.id|0];if(!g||r.picked.has(g.id))return;if(Math.hypot(c.x-g.x,c.y-g.y)>60){stats.pickRejected++;return;}r.picked.add(g.id);r.tally[by.id]=(r.tally[by.id]||0)+1;}
    else if(msg.kind==='key'){const k=r.L.keys[0];if(r.boss&&!r.boss.dead){stats.pickRejected++;return;}if(Math.hypot(c.x-k.x,c.y-k.y)>60){stats.pickRejected++;return;}r.keyOk=true;}break;}
  case 'world':{if(!r||r.host!==me.id)return;if(Array.isArray(msg.opened)&&r.L)for(const id of msg.opened.map(String)){if(r.opened.has(id))continue;
      if(id==='d0'?r.keyOk:id==='g0'?platesHeld(r):false)r.opened.add(id);else stats.openRejected++;}
    bcast(r,msg,me.id);if(r.boss&&r.boss.active&&!r.boss.dead&&(!r.bossSync||now()-r.bossSync>2)){r.bossSync=now();bcast(r,bossMsg(r));}break;}
  case 'tp':{if(!r||r.host!==me.id||!r.L)return;const p=r.players.get(msg.id);if(!p)return;const x=+msg.x,y=+msg.y;
    if(!isFinite(x)||!isFinite(y)||!validTp(r,p,x,y)){stats.tpRejected++;send(ws,{t:'tpno',id:p.id,x:p.pos.x,y:p.pos.y});return;}
    p.pos={x,y};p.bx=p.capX();p.by=1200;p.grace=now()+0.3;if(p!==me)send(p.ws,{t:'tp',id:p.id,x,y});break;}
  case 'level':{if(!r||r.host!==me.id||!r.L||!r.started)return;const n=msg.n|0;if(n!==r.levelN+1)return;const L=r.L,t=now();
    const fastest=Math.max(...[...r.players.values()].map(p=>GK.CHARS[p.char].speed));
    const atExit=[...r.players.values()].some(p=>Math.abs(center(p).x-L.exit.x)<80&&center(p).y>L.exit.y-110);
    const valid=r.keyOk&&r.opened.has('d0')&&atExit&&(t-r.levelT)>=GK.minClearTime(L,fastest)&&(!r.boss||r.boss.dead);
    const items=[];
    if(valid&&!r.awarded){r.awarded=true;stats.clearsValid++;items.push(...awardAll(r,'level clear L'+r.levelN,GK.POINTS.levelClear(r.levelN)));
      if(r.players.size>=2){const ent=[...r.players.values()].map(p=>[p,r.tally[p.id]||0]).sort((a,b)=>b[1]-a[1]);
        if(ent[0][1]>0&&ent[0][1]>ent[1][1]&&ent[0][0].profile){const p=ent[0][0];items.push({id:p.id,nick:p.name,ev:'round win L'+r.levelN+' ('+ent[0][1]+' gems)',pts:GK.POINTS.roundWin,granted:grant(p.profile,'round win L'+r.levelN,GK.POINTS.roundWin)});}}}
    else if(!valid){stats.clearsInvalid++;bcast(r,{t:'awards',items:[],note:'Level clear not verified by server: no points'});}
    award(r,items);
    const host=r.players.get(r.host);
    if(n>GK.LEVEL_COUNT){r.started=false;bcast(r,{t:'level',n});}
    else if(levelOk(host.profile,n)){setLevel(r,n);bcast(r,{t:'level',n});}
    else{r.started=false;r.L=null;bcast(r,{t:'runend',msg:'Level '+n+' is locked on the host profile. Unlock it with points, then start again.'});bcast(r,{t:'lobby',players:roster(r)});}
    break;}
}}
server.listen(CFG.port,'0.0.0.0',()=>console.log('Gemlight Keep server on http://localhost:'+CFG.port+'  dev='+CFG.dev+' dailyCap='+CFG.dailyCap+' data='+CFG.data));
setInterval(()=>{if(process.env.GK_STATS)console.log('stats',JSON.stringify(stats));},5000).unref();
