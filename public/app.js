const $ = (id) => document.getElementById(id);
const state = { socket:null, roomCode:null, playerId:null, name:null, host:false, players:[], phase:"lobby", radius:220, pingInterval:60, seekersCount:1, me:null, pings:[], lastPingAt:0, keys:new Set(), lastMove:0, world:{w:900,h:600}, mapSeed:1337 };
const canvas=$("map"), ctx=canvas.getContext("2d");
const random=(seed)=>{let x=Math.sin(seed*127.1+311.7)*43758.5453;return x-Math.floor(x)};
function message(text){$("lobbyMessage").textContent=text}
function gameMessage(text){$("gameMessage").textContent=text}
function send(type,data={}){if(state.socket&&state.socket.readyState===WebSocket.OPEN)state.socket.send(JSON.stringify({type,...data}))}
function setPhase(phase){state.phase=phase;$("roundBadge").textContent=phase.toUpperCase();$("startGame").classList.toggle("hidden",phase!=="waiting");$("endGame").classList.toggle("hidden",phase==="waiting");$("hostSettings").classList.toggle("hidden",!state.host);$("mapHint").textContent=phase==="playing"?"WASD / ARROWS TO MOVE · E TO TAG":"WASD / ARROW KEYS TO MOVE"}
function connect(code,create=false){
  const name=$("playerName").value.trim()||"Player"+Math.floor(Math.random()*900+100);
  state.name=name;state.roomCode=code;
  const scheme=location.protocol==="https:"?"wss:":"ws:";
  const url=`${scheme}//${location.host}/api/room/${code}`;
  const ws=new WebSocket(url);state.socket=ws;
  ws.addEventListener("open",()=>ws.send(JSON.stringify({type:create?"create":"join",name,playerId:state.playerId})));
  ws.addEventListener("message",event=>{let data;try{data=JSON.parse(event.data)}catch{return}handle(data)});
  ws.addEventListener("close",()=>{if(state.phase!=="lobby")gameMessage("Connection closed. Refresh to reconnect.")});
  ws.addEventListener("error",()=>{message("Could not connect. Check your connection and try again.")});
}
function handle(d){
  if(d.type==="error"){message(d.message||"Something went wrong.");gameMessage(d.message||"Something went wrong.");return}
  if(d.type==="joined"){
    state.playerId=d.playerId;state.roomCode=d.roomCode;state.host=d.host;state.radius=d.settings.radius;state.pingInterval=d.settings.pingInterval;state.seekersCount=d.settings.seekersCount;
    $("activeRoomCode").textContent=d.roomCode;$("radius").value=state.radius;$("radiusValue").textContent=state.radius+"m";$("pingInterval").value=String(state.pingInterval);$("seekersCount").value=String(state.seekersCount);
    $("lobby").classList.add("hidden");$("game").classList.remove("hidden");setPhase(d.phase);gameMessage(d.message||"Waiting for players to join…");return;
  }
  if(d.type==="state"){
    state.players=d.players||[];state.phase=d.phase;state.radius=d.settings.radius;state.pingInterval=d.settings.pingInterval;state.seekersCount=d.settings.seekersCount;state.host=d.hostId===state.playerId;
    state.me=state.players.find(p=>p.id===state.playerId)||null;
    $("playerCount").textContent=state.players.length;
    $("hostSettings").classList.toggle("hidden",!state.host);
    $("radius").value=state.radius;$("radiusValue").textContent=state.radius+"m";$("pingInterval").value=String(state.pingInterval);$("seekersCount").value=String(state.seekersCount);
    $("playersList").innerHTML=state.players.map(p=>`<div class="player-item"><div class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div><span class="player-name">${escapeHtml(p.name)}${p.id===state.playerId?" (you)":""}</span><span class="role ${p.role==="seeker"?"seeker":""}">${p.role==="seeker"?"SEEKER":p.role==="hider"?"HIDER":"WAITING"}</span></div>`).join("");
    setPhase(d.phase);if(d.message)gameMessage(d.message);
    if(d.pings)state.pings=d.pings;
    return;
  }
  if(d.type==="ping"){state.pings.push({...d.ping,receivedAt:Date.now()});gameMessage("📡 A hider ping was detected! Check the map for a temporary clue.");return}
  if(d.type==="tagged"){gameMessage(d.message);return}
  if(d.type==="left"){gameMessage(d.message||"A player left.");}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function makeCode(){return Array.from(crypto.getRandomValues(new Uint8Array(6))).map(x=>"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x%32]).join("")}
$("createRoom").onclick=()=>{message("");connect(makeCode(),true)};
$("joinRoom").onclick=()=>{const code=$("roomCode").value.trim().toUpperCase();if(code.length<4){message("Enter the room code your host shared.");return}message("");connect(code,false)};
$("roomCode").addEventListener("input",e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6));
$("radius").addEventListener("input",e=>$("radiusValue").textContent=e.target.value+"m");
$("saveSettings").onclick=()=>send("settings",{radius:Number($("radius").value),pingInterval:Number($("pingInterval").value),seekersCount:Number($("seekersCount").value)});
$("startGame").onclick=()=>send("start");
$("endGame").onclick=()=>send("end");
$("copyCode").onclick=async()=>{try{await navigator.clipboard.writeText(state.roomCode);$("copyCode").textContent="Copied!"}catch{$("copyCode").textContent=state.roomCode}setTimeout(()=>$("copyCode").textContent="Copy",1300)};
$("leaveRoom").onclick=()=>{if(state.socket)state.socket.close();state.socket=null;state.phase="lobby";state.roomCode=null;state.players=[];$("game").classList.add("hidden");$("lobby").classList.remove("hidden");message("")};
window.addEventListener("keydown",e=>{if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key))e.preventDefault();state.keys.add(e.key.toLowerCase());if(e.key.toLowerCase()==="e")send("tag")});
window.addEventListener("keyup",e=>state.keys.delete(e.key.toLowerCase()));
function moveLoop(now){
  if(state.phase==="playing"&&state.me&&now-state.lastMove>70){
    let dx=0,dy=0;if(state.keys.has("w")||state.keys.has("arrowup"))dy--;if(state.keys.has("s")||state.keys.has("arrowdown"))dy++;if(state.keys.has("a")||state.keys.has("arrowleft"))dx--;if(state.keys.has("d")||state.keys.has("arrowright"))dx++;
    if(dx||dy){const len=Math.hypot(dx,dy)||1;send("move",{dx:dx/len,dy:dy/len});state.lastMove=now}
  }
  draw();requestAnimationFrame(moveLoop)
}
function draw(){
  const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
  ctx.fillStyle="#315744";ctx.fillRect(0,0,w,h);
  // Stylized grass patches and forest canopy.
  for(let i=0;i<180;i++){const x=random(i+2)*w,y=random(i+555)*h;ctx.fillStyle=i%2?"#37634a":"#2c503f";ctx.beginPath();ctx.ellipse(x,y,8+random(i+8)*18,5+random(i+9)*12,random(i+11)*3,0,Math.PI*2);ctx.fill()}
  // Winding paths.
  ctx.lineCap="round";ctx.lineJoin="round";ctx.strokeStyle="#b3a17b";ctx.lineWidth=36;ctx.beginPath();ctx.moveTo(-20,450);ctx.bezierCurveTo(180,380,170,210,390,275);ctx.bezierCurveTo(590,340,620,90,920,135);ctx.stroke();
  ctx.strokeStyle="#d0bd91";ctx.lineWidth=23;ctx.stroke();
  // Pond.
  ctx.fillStyle="#477f87";ctx.beginPath();ctx.ellipse(710,440,100,57,-.2,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#78a8a2";ctx.lineWidth=4;ctx.stroke();
  // Trees.
  for(let i=0;i<65;i++){const x=random(i+90)*w,y=random(i+190)*h;if((x>280&&x<540&&y>220&&y<350)||(x>610&&x<820&&y>390&&y<500))continue;drawTree(x,y,0.55+random(i+80)*.65)}
  // Playable circle.
  const cx=w/2,cy=h/2,r=Math.min(w,h)*(.18+state.radius/1000);
  ctx.save();ctx.setLineDash([10,8]);ctx.strokeStyle="#c2f27c";ctx.lineWidth=3;ctx.fillStyle="#b8f36b0c";ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();
  // Ping clues, visible to seekers only.
  const now=Date.now();state.pings=state.pings.filter(p=>now-(p.receivedAt||now)<6500);
  state.pings.forEach(p=>{if(state.me?.role==="seeker"&&p.x!=null){const x=p.x/900*w,y=p.y/600*h;ctx.beginPath();ctx.arc(x,y,25+((now-(p.receivedAt||now))%900)/900*45,0,Math.PI*2);ctx.strokeStyle="#ffb36caa";ctx.lineWidth=4;ctx.stroke();ctx.fillStyle="#ffb36c";ctx.font="bold 12px Manrope";ctx.fillText("PING",x+12,y-12)}})
  state.players.forEach(p=>{const x=(p.x||450)/900*w,y=(p.y||300)/600*h;drawPlayer(x,y,p)});
  ctx.fillStyle="#eff8e8";ctx.font="11px 'DM Mono'";ctx.fillText("FOREST ZONE",18,24);
}
function drawTree(x,y,s){ctx.fillStyle="#1d392d";ctx.beginPath();ctx.ellipse(x+3*s,y+8*s,17*s,7*s,0,0,Math.PI*2);ctx.fill();ctx.fillStyle="#6b5237";ctx.fillRect(x-3*s,y,6*s,16*s);ctx.fillStyle="#1d4936";ctx.beginPath();ctx.moveTo(x,y-29*s);ctx.lineTo(x-20*s,y+4*s);ctx.lineTo(x+20*s,y+4*s);ctx.closePath();ctx.fill();ctx.fillStyle="#2e6545";ctx.beginPath();ctx.moveTo(x,y-39*s);ctx.lineTo(x-16*s,y-9*s);ctx.lineTo(x+16*s,y-9*s);ctx.closePath();ctx.fill()}
function drawPlayer(x,y,p){const mine=p.id===state.playerId;ctx.fillStyle=p.role==="seeker"?"#ffb36c":mine?"#d4ff91":"#c2e6db";ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#14251d";ctx.lineWidth=3;ctx.stroke();ctx.fillStyle="#14251d";ctx.beginPath();ctx.arc(x-3,y-2,1.5,0,Math.PI*2);ctx.arc(x+3,y-2,1.5,0,Math.PI*2);ctx.fill();if(mine||p.role==="seeker"){ctx.font="bold 12px Manrope";ctx.textAlign="center";ctx.fillStyle="#fff";ctx.fillText(p.name,x,y-17);ctx.textAlign="left"}}
requestAnimationFrame(moveLoop);
