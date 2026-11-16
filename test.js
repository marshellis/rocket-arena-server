/* Protocol test: two clients queue -> match -> vote (tie) -> start -> relay -> leave */
const {spawn}=require('child_process');
const crypto=require('crypto');
const PORT=18787,REQ_PORT=18788,SECRET='test-secret-not-real';
const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT,GAME_PASS_SECRET:SECRET}});
const srvReq=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:REQ_PORT,GAME_PASS_SECRET:SECRET,GAME_PASS_REQUIRED:'1'}});
let out='';srv.stdout.on('data',d=>out+=d);srv.stderr.on('data',d=>out+=d);
// same algorithm as pass.js: base64url(claims).base64url(HMAC-SHA256(body, secret))
const now=()=>Math.floor(Date.now()/1000);
function sign(claims,secret=SECRET){const body=Buffer.from(JSON.stringify(claims)).toString('base64url');return body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');}
const pass=(u,over={})=>sign({u,a:'fox',c:'#f80',room:'rocket-arena',exp:now()+60,lb:true,...over});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  FAIL ')+m);if(!c)fails++;};

function client(name,car,query='',port=PORT){
  const ws=new WebSocket('ws://127.0.0.1:'+port+(query?'/?pass='+query:''));const log=[];const c={ws,log,code:null,
    send:o=>ws.send(JSON.stringify(o)),
    wait:async(t,ms=6000)=>{const t0=Date.now();while(Date.now()-t0<ms){const i=log.findIndex(m=>m.t===t);if(i>=0)return log.splice(i,1)[0];await sleep(20);}return null;}};
  ws.onmessage=e=>log.push(JSON.parse(e.data));
  ws.onclose=e=>{c.code=e.code;};
  return new Promise(res=>{ws.onopen=()=>res(c);});
}

(async()=>{
  await sleep(700);
  console.log('server up:',out.includes('running')?'yes':'NO');
  const A=await client(),B=await client();
  A.send({t:'queue',name:'Alice',car:'neon'});
  ok((await A.wait('queued'))!==null,'first player is queued');
  B.send({t:'queue',name:'Bob',car:'tank'});
  const ma=await A.wait('matched'),mb=await B.wait('matched');
  ok(ma&&ma.role==='host'&&ma.opp.name==='BOB'&&ma.opp.car==='tank','waiting player becomes HOST and sees opponent');
  ok(mb&&mb.role==='guest'&&mb.opp.name==='ALICE','joiner becomes GUEST');
  ok(ma.maps.length===3,'3 maps offered');
  A.send({t:'vote',map:'neon'});
  ok((await B.wait('voted'))!==null,'opponent is told a vote came in');
  B.send({t:'vote',map:'frost'});
  const r1=await A.wait('map'),r2=await B.wait('map');
  ok(r1&&r2&&r1.id===r2.id,'both get the same map result: '+(r1&&r1.id));
  ok(r1&&r1.tie===true&&['neon','frost'].includes(r1.id),'different votes = tie, random pick between the voted maps');
  ok((await A.wait('start',7000))!==null&&(await B.wait('start',7000))!==null,'match start sent to both');
  A.send({t:'snap',s:{x:1}});B.send({t:'in',i:[1,0,0,0,0,0,0,0]});
  ok((await B.wait('snap'))!==null,'host snapshot relayed to guest');
  ok((await A.wait('in'))!==null,'guest input relayed to host');
  B.ws.close();
  ok((await A.wait('opp_left'))!==null,'host told when guest leaves');
  // same-map vote -> no tie
  const C=await client(),D=await client();
  C.send({t:'queue',name:'C'});D.send({t:'queue',name:'D'});
  await C.wait('matched');await D.wait('matched');
  C.send({t:'vote',map:'frost'});D.send({t:'vote',map:'frost'});
  const r3=await C.wait('map');
  ok(r3&&r3.id==='frost'&&r3.tie===false,'same vote -> that map, not a tie');
  /* ---------------- protocol versions ---------------- */
  console.log('versions:');
  {const O=await client(),N=await client(),N2=await client();
   O.send({t:'queue',name:'Old'});await O.wait('queued');                       // no ver = 1
   N.send({t:'queue',name:'New',ver:2});await N.wait('queued');
   ok(O.log.every(m=>m.t!=='matched')&&N.log.every(m=>m.t!=='matched'),'a v1 page and a v2 page are NOT paired');
   N2.send({t:'queue',name:'New2',ver:2});
   const m1=await N.wait('matched'),m2=await N2.wait('matched');
   ok(m1&&m2&&m1.opp.name==='NEW2','two v2 players are paired');
   O.ws.close();N.ws.close();N2.ws.close();}

  /* ---------------- family game pass ---------------- */
  console.log('game pass:');
  // verified player: name comes from the pass, not from what the browser sends
  const V=await client('','',pass('Zoe')),G=await client();
  ok((await V.wait('hello'))?.verified===true,'valid pass -> hello says verified');
  V.send({t:'queue',name:'Mallory',car:'neon'});await V.wait('queued');
  G.send({t:'queue',name:'Bob'});
  const mv=await V.wait('matched'),mg=await G.wait('matched');
  ok(mg&&mg.opp.name==='ZOE','opponent sees the name from the pass, not the browser-sent name');
  ok(mv&&mv.opp.name==='BOB','guests keep the name they typed');
  // pass for another room / wrong secret / tampered / expired / not a pass = a guest named from the queue message
  const bad=[['wrong room',pass('Eve',{room:'nexus'})],['wrong secret',sign({u:'Eve',room:'rocket-arena',exp:now()+60},'other')],
    ['tampered',pass('Eve').slice(0,-2)+'xx'],['expired',pass('Eve',{exp:now()-5})],['garbage','not-a-pass']];
  for(const [why,tok] of bad){
    const X=await client('','',tok);const h=await X.wait('hello');
    X.send({t:'queue',name:'Guesty'});
    ok(h&&h.verified===false&&h.name===null,'bad pass ('+why+') is treated as a guest');
    X.ws.close();
  }
  // renew: same user + room moves the expiry; someone else's pass is ignored; expiry -> timeup + close 4003
  const fresh=now()+60;
  const RN=await client('','',pass('Ann',{exp:now()+2})),BD=await client('','',pass('Bo',{exp:now()+2})),TU=await client('','',pass('Tim',{exp:now()+1}));
  await RN.wait('hello');await BD.wait('hello');await TU.wait('hello');
  RN.send({type:'renew',pass:pass('Ann',{exp:fresh})});
  BD.send({type:'renew',pass:pass('Eve',{exp:fresh})});
  await sleep(3500);
  ok(RN.log.some(m=>m.type==='renewed'&&m.exp===fresh)&&RN.code===null&&!RN.log.some(m=>m.type==='timeup'),'renewed pass stays open past the old expiry');
  ok(BD.log.some(m=>m.type==='timeup')&&BD.code===4003,"someone else's renew is ignored; original expiry stands");
  ok(TU.log.some(m=>m.type==='timeup')&&TU.code===4003,'expiry -> timeup message then close 4003');
  RN.ws.close();
  // time-up of a matched player tells the opponent
  const P1=await client('','',pass('Pia',{exp:now()+3})),P2=await client();
  await P1.wait('hello');P1.send({t:'queue',name:'x'});await P1.wait('queued');P2.send({t:'queue',name:'y'});
  await P1.wait('matched');await P2.wait('matched');
  ok((await P2.wait('opp_left',6000))!==null,'when a matched player runs out of time the opponent is told');
  // GAME_PASS_REQUIRED=1: guests are refused, a valid pass gets in
  const Q1=await client('','','',REQ_PORT),Q2=await client('','',pass('Max'),REQ_PORT);
  await sleep(500);
  ok(Q1.log.some(m=>m.t==='signin')&&Q1.code===4001,'GAME_PASS_REQUIRED=1 refuses a guest (signin, then close 4001)');
  ok(Q2.log.some(m=>m.t==='hello')&&Q2.code===null,'GAME_PASS_REQUIRED=1 lets a valid pass in');
  Q2.ws.close();V.ws.close();G.ws.close();P2.ws.close();

  A.ws.close();C.ws.close();D.ws.close();
  await sleep(200);
  srvReq.kill();
  srv.kill();
  console.log(fails?('\n'+fails+' FAILED'):'\nALL PASSED');
  process.exit(fails?1:0);
})();
