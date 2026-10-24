const $ = id => document.getElementById(id);
// Public Pages frontend; multiplayer WebSocket API is hosted by the separate Cloudflare Worker.
const MULTIPLAYER_WORKER_URL = "wss://hideout.eshaan-automotivemail.workers.dev";
const state = {
  socket:null, roomCode:null, playerId:null, name:null, host:false, players:[],
  phase:"lobby", radius:500, pingInterval:60, seekersCount:1, me:null,
  boundary:null, watchId:null, map:null, markers:new Map(), zone:null, pingLayers:[],
  lastLocationAt:0, lastPingAt:0, pendingCatch:false
};

function message(text){ $("lobbyMessage").textContent=text; }
function gameMessage(text){ $("gameMessage").textContent=text; }
function send(type,data={}) {
  if(state.socket && state.socket.readyState===WebSocket.OPEN) state.socket.send(JSON.stringify({type,...data}));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function setPhase(phase) {
  state.phase=phase;
  $("roundBadge").textContent=phase.toUpperCase();
  $("startGame").classList.toggle("hidden",phase!=="waiting");
  $("endGame").classList.toggle("hidden",phase==="waiting");
  $("hostSettings").classList.toggle("hidden",!state.host);
  $("mapHint").textContent=phase==="playing"?"LIVE GPS · E TO REQUEST TAG":"LIVE GPS POSITIONS";
  if(phase!=="playing") hideCatchPrompt();
  if(phase==="playing") startLocationSharing();
  else stopLocationSharing();
}
function connect(code,create=false) {
  if(state.socket) { try { state.socket.close(); } catch {} }
  const name=$("playerName").value.trim()||"Player"+Math.floor(Math.random()*900+100);
  state.name=name; state.roomCode=code;
  const ws=new WebSocket(`${MULTIPLAYER_WORKER_URL}/api/room/${code}`);
  state.socket=ws;
  ws.addEventListener("open",()=>ws.send(JSON.stringify({type:create?"create":"join",name})));
  ws.addEventListener("message",event=>{let d;try{d=JSON.parse(event.data)}catch{return}handle(d)});
  ws.addEventListener("close",()=>{stopLocationSharing();if(state.phase!=="lobby")gameMessage("Connection closed. Location sharing stopped. Reconnect to continue.")});
  ws.addEventListener("error",()=>message("Could not connect. Check your connection and try again."));
}
function handle(d) {
  if(d.type==="error"){message(d.message||"Something went wrong.");gameMessage(d.message||"Something went wrong.");return;}
  if(d.type==="joined") {
    state.playerId=d.playerId;state.roomCode=d.roomCode;state.host=d.host;
    state.radius=d.settings.radius;state.pingInterval=d.settings.pingInterval;state.seekersCount=d.settings.seekersCount;state.boundary=d.boundary||null;
    $("activeRoomCode").textContent=d.roomCode;
    $("radius").value=state.radius;$("radiusValue").textContent=state.radius+"m";
    $("pingInterval").value=String(state.pingInterval);$("seekersCount").value=String(state.seekersCount);
    $("lobby").classList.add("hidden");$("game").classList.remove("hidden");
    initMap();updateBoundary();setPhase(d.phase);updateBoundaryStatus();
    gameMessage(d.message||"Waiting for players to join…");
    return;
  }
  if(d.type==="state") {
    const oldPhase=state.phase;
    state.players=d.players||[];state.host=d.hostId===state.playerId;
    state.me=state.players.find(p=>p.id===state.playerId)||null;
    state.radius=d.settings?.radius||state.radius;
    state.pingInterval=d.settings?.pingInterval||state.pingInterval;
    state.seekersCount=d.settings?.seekersCount||state.seekersCount;
    state.boundary=d.boundary||null;
    $("playerCount").textContent=state.players.length;
    $("hostSettings").classList.toggle("hidden",!state.host);
    $("radius").value=state.radius;$("radiusValue").textContent=state.radius+"m";
    $("pingInterval").value=String(state.pingInterval);$("seekersCount").value=String(state.seekersCount);
    $("playersList").innerHTML=state.players.map(p=>`<div class="player-item"><div class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div><span class="player-name">${escapeHtml(p.name)}${p.id===state.playerId?" (you)":""}</span><span class="role ${p.role==="seeker"?"seeker":""}">${p.outOfBounds?"OUTSIDE":p.role==="seeker"?"SEEKER":p.role==="hider"?"HIDER":"WAITING"}</span></div>`).join("");
    setPhase(d.phase);updateBoundary();renderPlayers();updateBoundaryStatus();
    if(d.message)gameMessage(d.message);
    if(oldPhase==="playing"&&d.phase!=="playing")clearPingLayers();
    return;
  }
  if(d.type==="ping") {
    const p=d.ping;
    if(p&&state.map&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)) {
      const ring=L.circle([p.lat,p.lon],{radius:35,color:"#ffb36c",weight:2,fillOpacity:.08}).addTo(state.map);
      state.pingLayers.push(ring);setTimeout(()=>{if(state.map&&state.map.hasLayer(ring))state.map.removeLayer(ring);state.pingLayers=state.pingLayers.filter(x=>x!==ring)},6500);
    }
    gameMessage(d.message || (d.ping?.reason==="hider-left-zone" ? "📡 A hider left the hiding zone — location pinged!" : "📡 A hider clue was detected. Check the map."));
    return;
  }
  if(d.type==="catchRequest") {
    state.pendingCatch=true;
    $("catchPromptText").textContent=d.message || (d.seekerName+" says they caught you.");
    $("catchPrompt").classList.remove("hidden");
    gameMessage("A seeker has requested catch confirmation.");
    return;
  }
  if(d.type==="tagged") gameMessage(d.message);
}
function makeCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6))).map(x=>"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x%32]).join("");
}

function initMap() {
  if(state.map || !window.L) return;
  state.map=L.map("realMap",{zoomControl:true}).setView([20,0],2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(state.map);
  state.map.on("click",e=>{
    if(!state.host||state.phase==="playing")return;
    if(!confirm("Set the safe play area's centre to this map location?"))return;
    send("setBoundary",{lat:e.latlng.lat,lon:e.latlng.lng,radius:Number($("radius").value)});
    gameMessage("Updating safe-zone centre…");
  });
  setTimeout(()=>state.map.invalidateSize(),150);
}
function updateBoundary() {
  if(!state.map)return;
  if(state.zone){state.map.removeLayer(state.zone);state.zone=null;}
  if(!state.boundary)return;
  state.zone=L.circle([state.boundary.lat,state.boundary.lon],{
    radius:state.boundary.radius,color:"#b8f36b",weight:3,fillColor:"#b8f36b",fillOpacity:.10
  }).addTo(state.map);
  state.zone.bindPopup(`Hiding zone · ${state.boundary.radius} m radius`);
  if(!state.map._hideoutHasFittedZone) {
    state.map.fitBounds(state.zone.getBounds().pad(.18));
    state.map._hideoutHasFittedZone=true;
  }
}
function renderPlayers() {
  if(!state.map)return;
  const active=state.phase==="playing";
  const seen=new Set();
  for(const p of state.players) {
    if(!active||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))continue;
    seen.add(p.id);
    const color=p.outOfBounds?"#ff5c67":p.role==="seeker"?"#ffb36c":p.id===state.playerId?"#b8f36b":"#7edbd0";
    const html=`<div class="gps-pin" style="--pin-color:${color}"><span></span></div>`;
    const icon=L.divIcon({className:"gps-marker",html,iconSize:[28,36],iconAnchor:[14,30]});
    const label=`${escapeHtml(p.name)}${p.id===state.playerId?" (you)":""}${p.outOfBounds?" · OUTSIDE SAFE ZONE":""}`;
    if(!state.markers.has(p.id)) {
      const marker=L.marker([p.lat,p.lon],{icon}).addTo(state.map);
      marker.bindTooltip(label,{direction:"top",offset:[0,-18]});state.markers.set(p.id,marker);
    } else {
      const marker=state.markers.get(p.id);
      marker.setLatLng([p.lat,p.lon]);marker.setIcon(icon);marker.setTooltipContent(label);
    }
  }
  for(const [id,marker] of state.markers) {
    if(!seen.has(id)){state.map.removeLayer(marker);state.markers.delete(id);}
  }
}
function updateBoundaryStatus() {
  const el=$("boundaryStatus");
  if(!state.boundary)el.textContent="Set the hiding-zone centre before starting.";
  else el.textContent=`Hiding zone set · ${Math.round(state.boundary.lat*10000)/10000}, ${Math.round(state.boundary.lon*10000)/10000} · ${state.boundary.radius} m radius`;
}
function getCurrentPosition() {
  return new Promise((resolve,reject)=>{
    if(!("geolocation" in navigator)){reject(new Error("This browser does not support GPS location."));return;}
    navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000,maximumAge:0});
  });
}
async function setBoundaryFromGPS() {
  if(!state.host){gameMessage("Only the host can set the safe zone.");return;}
  $("setBoundary").disabled=true;$("setBoundary").textContent="Getting GPS…";
  try {
    const pos=await getCurrentPosition();
    send("setBoundary",{lat:pos.coords.latitude,lon:pos.coords.longitude,radius:Number($("radius").value)});
    if(state.map)state.map.setView([pos.coords.latitude,pos.coords.longitude],16);
    gameMessage("GPS acquired. Setting the hiding zone…");
  } catch(e) {
    gameMessage(locationError(e));
  } finally {
    $("setBoundary").disabled=false;$("setBoundary").textContent="◎ Set hiding zone to my location";
  }
}
function locationError(e) {
  if(e?.code===1)return "Location permission was denied. Allow location access in your browser settings and try again.";
  if(e?.code===2)return "Your location is unavailable. Try outdoors with device location enabled.";
  if(e?.code===3)return "GPS timed out. Try again in a moment.";
  return e?.message||"Could not get your location.";
}
function startLocationSharing() {
  if(state.watchId!==null||state.phase!=="playing")return;
  if(!navigator.geolocation){$("locationStatus").textContent="GPS unavailable";gameMessage("This browser does not support GPS. Use a location-enabled browser.");return;}
  $("locationStatus").textContent="Requesting GPS permission…";
  state.watchId=navigator.geolocation.watchPosition(pos=>{
    if(state.phase!=="playing")return;
    const now=Date.now();
    if(now-state.lastLocationAt<1200)return;
    state.lastLocationAt=now;
    $("locationStatus").textContent=`GPS live · ±${Math.round(pos.coords.accuracy)}m`;
    send("location",{lat:pos.coords.latitude,lon:pos.coords.longitude,accuracy:pos.coords.accuracy});
    if(state.map&&state.map.getZoom()<13)state.map.setView([pos.coords.latitude,pos.coords.longitude],15);
  },err=>{
    $("locationStatus").textContent="GPS permission needed";
    gameMessage(locationError(err));
  },{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
}
function stopLocationSharing() {
  if(state.watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(state.watchId);
  state.watchId=null;state.lastLocationAt=0;
  if($("locationStatus"))$("locationStatus").textContent="GPS sharing stopped";
  if(state.map) {
    for(const marker of state.markers.values())state.map.removeLayer(marker);
    state.markers.clear();
  }
}
function clearPingLayers() {
  if(state.map)for(const layer of state.pingLayers)state.map.removeLayer(layer);
  state.pingLayers=[];
}

$("createRoom").onclick=()=>{message("");connect(makeCode(),true);};
$("joinRoom").onclick=()=>{const code=$("roomCode").value.trim().toUpperCase();if(code.length<4){message("Enter the room code your host shared.");return;}message("");connect(code,false);};
$("roomCode").addEventListener("input",e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6));
$("radius").addEventListener("input",e=>{$("radiusValue").textContent=e.target.value+"m";});
$("setBoundary").onclick=setBoundaryFromGPS;
function hideCatchPrompt(){state.pendingCatch=false;$("catchPrompt").classList.add("hidden");}
$("confirmCaught").onclick=()=>{if(state.pendingCatch)send("confirmCaught");hideCatchPrompt();gameMessage("Catch confirmed.");};
$("denyCaught").onclick=()=>{if(state.pendingCatch)send("denyCaught");hideCatchPrompt();gameMessage("Catch declined.");};
$("saveSettings").onclick=()=>send("settings",{radius:Number($("radius").value),pingInterval:Number($("pingInterval").value),seekersCount:Number($("seekersCount").value)});
$("startGame").onclick=()=>send("start");
$("endGame").onclick=()=>send("end");
$("copyCode").onclick=async()=>{try{await navigator.clipboard.writeText(state.roomCode);$("copyCode").textContent="Copied!";}catch{$("copyCode").textContent=state.roomCode;}setTimeout(()=>$("copyCode").textContent="Copy",1300);};
$("leaveRoom").onclick=()=>{
  stopLocationSharing();clearPingLayers();
  if(state.socket)state.socket.close();
  state.socket=null;state.phase="lobby";state.roomCode=null;state.players=[];state.boundary=null;state.host=false;
  state.markers.clear();state.zone=null;
  $("game").classList.add("hidden");$("lobby").classList.remove("hidden");message("");
};
window.addEventListener("keydown",e=>{if(e.key.toLowerCase()==="e"&&state.phase==="playing"&&state.me?.role==="seeker")send("tag");});
window.addEventListener("beforeunload",stopLocationSharing);
