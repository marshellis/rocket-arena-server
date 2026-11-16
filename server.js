/* ROCKET ARENA multiplayer server
 *  - serves the game (rocket-league.html) so friends only need a link
 *  - matchmaking queue: first waiting player pairs with the next one (1v1)
 *  - map vote (3 maps). Different votes = tie -> random pick between the voted maps
 *  - relays game traffic: the waiting player is the HOST (runs the physics),
 *    the joiner is the GUEST (sends inputs, receives snapshots)
 *
 *  - family game pass: ?pass=<token> gives a verified name + play-time limit (GAME_PASS_SECRET; GAME_PASS_REQUIRED=1 refuses guests)
 *  Run:  node server.js        (default port 8787, set PORT=xxxx to change)
 */
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const {WebSocketServer}=require('ws');
const {identify,watchPass}=require('./pass');   // family game pass (docs/room-kit/pass.js in marshellis/game-generator)
const ROOM='rocket-arena';                       // the room name the game asks mg.getPass() for

const PORT=+process.env.PORT||8787;
const GAME_FILE=path.join(__dirname,'..','rocket-league.html');
const MAPS=['valley','neon','frost'];
const VOTE_MS=15000, RESULT_MS=3500;

/* ---------------------------------------------------------------- http (serves the game) */
const server=http.createServer((req,res)=>{
  const url=(req.url||'/').split('?')[0];
  if(url==='/'||url==='/rocket-league.html'||url==='/index.html'){
    fs.readFile(GAME_FILE,(err,buf)=>{
      if(err){res.writeHead(302,{Location:'https://marshellis.com/arcade/rocket-league.html'});res.end();return;}   // hosted without the game file: send people to the site
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(buf);
    });
  }else if(url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,online:wss.clients.size,waiting:waiting?1:0,matches:matches.size}));
  }else{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}
});

/* ---------------------------------------------------------------- websocket */
const wss=new WebSocketServer({server});
let waiting=null;                 // socket waiting for an opponent (any page version: newer pages fall back gracefully when the other side is older)
const matches=new Map();          // id -> match
let nextId=1;

const send=(ws,obj)=>{if(ws&&ws.readyState===1){try{ws.send(JSON.stringify(obj));}catch(e){}}};
const clean=(v,max)=>String(v==null?'':v).replace(/[^\w \-]/g,'').trim().slice(0,max);
const online=()=>wss.clients.size;

function leaveEverything(ws,notify){
  if(waiting===ws)waiting=null;
  const m=ws.match;
  if(m){
    const other=m.host===ws?m.guest:m.host;
    clearTimeout(m.voteTimer);clearTimeout(m.startTimer);
    matches.delete(m.id);
    if(other){other.match=null;if(notify)send(other,{t:'opp_left'});}
    ws.match=null;
  }
}

function makeMatch(host,guest){
  const m={id:nextId++,host,guest,votes:{host:null,guest:null},phase:'vote',voteTimer:null,startTimer:null};
  host.match=m;guest.match=m;matches.set(m.id,m);
  send(host,{t:'matched',role:'host',opp:{name:guest.pname,car:guest.pcar},maps:MAPS,voteMs:VOTE_MS});
  send(guest,{t:'matched',role:'guest',opp:{name:host.pname,car:host.pcar},maps:MAPS,voteMs:VOTE_MS});
  m.voteTimer=setTimeout(()=>resolveVote(m),VOTE_MS);
  console.log(`[match ${m.id}] ${host.pname} (host, page v${host.pver||1}) vs ${guest.pname} (guest, page v${guest.pver||1})`);
}

function resolveVote(m){
  if(m.phase!=='vote'||!matches.has(m.id))return;
  m.phase='result';clearTimeout(m.voteTimer);
  const picks=[m.votes.host,m.votes.guest].filter(Boolean);
  const pool=picks.length?picks:MAPS;
  const count={};for(const p of pool)count[p]=(count[p]||0)+1;
  const best=Math.max(...Object.values(count));
  const top=Object.keys(count).filter(k=>count[k]===best);
  const tie=top.length>1||picks.length<2||m.votes.host!==m.votes.guest;
  const chosen=top[Math.floor(Math.random()*top.length)];
  const msg={t:'map',id:chosen,tie:top.length>1,picks:{host:m.votes.host,guest:m.votes.guest}};
  send(m.host,msg);send(m.guest,msg);
  console.log(`[match ${m.id}] votes ${JSON.stringify(m.votes)} -> ${chosen}${top.length>1?' (tie, random)':''}`);
  m.startTimer=setTimeout(()=>{
    if(!matches.has(m.id))return;
    m.phase='live';
    send(m.host,{t:'start'});send(m.guest,{t:'start'});
  },RESULT_MS);
}

wss.on('connection',(ws,req)=>{
  // ?pass=<token> from the family platform. No/invalid pass = guest, or refused when GAME_PASS_REQUIRED=1.
  const who=identify(new URL(req.url||'/','http://x').searchParams.get('pass'),process.env,Date.now()/1000,{room:ROOM});
  if(!who){send(ws,{t:'signin'});ws.close(4001,'pass required');return;}
  ws.isAlive=true;ws.pname='PLAYER';ws.pcar='striker';ws.match=null;
  ws.vname=null;                                   // name that came from a verified pass (the browser cannot change it)
  if(who.verified){
    ws.vname=clean(who.name,12).toUpperCase()||null;
    ws.watch=watchPass(ws,who,{room:ROOM,secret:process.env.GAME_PASS_SECRET,onTimeUp:()=>leaveEverything(ws,true)});
  }
  ws.on('pong',()=>{ws.isAlive=true;});
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch(e){return;}
    if(!msg||typeof msg!=='object')return;
    if(msg.type==='renew'){if(ws.watch&&typeof msg.pass==='string')ws.watch.renew(msg.pass);return;}   // bad/foreign pass: ignored
    const m=ws.match;
    switch(msg.t){
      case 'queue':{
        leaveEverything(ws,true);
        ws.pname=ws.vname||clean(msg.name,12).toUpperCase()||'PLAYER';ws.pcar=clean(msg.car,20)||'striker';
        ws.pver=+msg.ver||1;   // informational (shown in the match log): a page without ver is the older netcode
        if(waiting&&waiting!==ws&&waiting.readyState===1){const host=waiting;waiting=null;makeMatch(host,ws);}
        else{waiting=ws;send(ws,{t:'queued',online:online()});}
        break;}
      case 'leave':leaveEverything(ws,true);break;
      case 'vote':
        if(m&&m.phase==='vote'&&MAPS.includes(msg.map)){
          const side=m.host===ws?'host':'guest';m.votes[side]=msg.map;
          send(side==='host'?m.guest:m.host,{t:'voted'});
          if(m.votes.host&&m.votes.guest)resolveVote(m);
        }
        break;
      case 'in':   if(m&&m.phase==='live'&&m.guest===ws)send(m.host,msg);break;     // guest -> host
      case 'snap': if(m&&m.phase==='live'&&m.host===ws)send(m.guest,msg);break;     // host -> guest
      case 'ev':   if(m&&m.phase==='live'&&m.host===ws)send(m.guest,msg);break;
      case 'done': leaveEverything(ws,false);break;
    }
  });
  ws.on('close',()=>leaveEverything(ws,true));
  ws.on('error',()=>{});
  send(ws,{t:'hello',online:online(),name:ws.vname,verified:!!who.verified});
});

// keep-alive + tell people in the queue how many are online
setInterval(()=>{
  for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;try{ws.ping();}catch(e){}}
  if(waiting)send(waiting,{t:'online',online:online()});
},10000);

server.listen(PORT,'0.0.0.0',()=>{
  console.log('\n  ROCKET ARENA server running\n');
  console.log('  This computer:   http://localhost:'+PORT);
  const nets=os.networkInterfaces();
  for(const k of Object.keys(nets))for(const n of nets[k]||[])if(n.family==='IPv4'&&!n.internal)console.log('  Same Wi-Fi/LAN:  http://'+n.address+':'+PORT);
  console.log('\n  Friends open one of those links, press PLAY -> REAL PLAYERS.');
  console.log('  For internet play, expose this port (e.g. `ngrok http '+PORT+'`) and share that link.\n');
});
