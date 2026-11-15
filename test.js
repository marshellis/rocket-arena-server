/* Protocol test: two clients queue -> match -> vote (tie) -> start -> relay -> leave */
const {spawn}=require('child_process');
const PORT=18787;
const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT}});
let out='';srv.stdout.on('data',d=>out+=d);srv.stderr.on('data',d=>out+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ok=(c,m)=>{console.log((c?'  ok   ':'  FAIL ')+m);if(!c)fails++;};

function client(name,car){
  const ws=new WebSocket('ws://127.0.0.1:'+PORT);const log=[];const c={ws,log,
    send:o=>ws.send(JSON.stringify(o)),
    wait:async(t,ms=6000)=>{const t0=Date.now();while(Date.now()-t0<ms){const i=log.findIndex(m=>m.t===t);if(i>=0)return log.splice(i,1)[0];await sleep(20);}return null;}};
  ws.onmessage=e=>log.push(JSON.parse(e.data));
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
  A.ws.close();C.ws.close();D.ws.close();
  await sleep(200);
  srv.kill();
  console.log(fails?('\n'+fails+' FAILED'):'\nALL PASSED');
  process.exit(fails?1:0);
})();
