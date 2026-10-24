export { GameRoom };

const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control":"no-store" }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4,6})$/i);
    if (match) {
      const code = match[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

class GameRoom {
  constructor(ctx, env) {
    this.ctx=ctx; this.env=env;
    this.players=new Map();
    this.hostId=null;
    this.phase="waiting";
    this.settings={radius:220,pingInterval:60,seekersCount:1};
    this.lastPing=Date.now();
    this.roomCode=null;
    this.pings=[];
    this.ctx.blockConcurrencyWhile(async()=>{const saved=await this.ctx.storage.get("room");if(saved){this.hostId=saved.hostId;this.phase=saved.phase||"waiting";this.settings=saved.settings||this.settings;this.lastPing=saved.lastPing||Date.now();this.roomCode=saved.roomCode||null;this.pings=saved.pings||[];}});
  }
  async fetch(request) {
    if(request.headers.get("Upgrade")!=="websocket") return new Response("WebSocket required",{status:426});
    const pair=new WebSocketPair();const client=pair[0],server=pair[1];server.accept();
    let playerId=null;
    server.addEventListener("message",async event=>{
      let msg;try{msg=JSON.parse(event.data)}catch{return}
      if(msg.type==="create"||msg.type==="join"){
        const name=String(msg.name||"Player").trim().slice(0,18)||"Player";
        if(msg.type==="join"&&this.players.size===0&&!this.hostId){server.send(JSON.stringify({type:"error",message:"Room not found. Ask the host to create it first."}));return}
        if(this.players.size>=20){server.send(JSON.stringify({type:"error",message:"This room is full (20 players max)."}));return}
        playerId=crypto.randomUUID();
        const isHost=!this.hostId||msg.type==="create";
        if(msg.type==="create"&&this.players.size>0){server.send(JSON.stringify({type:"error",message:"A room with that code already exists. Try creating another room."}));return}
        if(isHost)this.hostId=playerId;
        const player={id:playerId,name,role:"waiting",x:450+(Math.random()-.5)*90,y:300+(Math.random()-.5)*90,alive:true,ws:server};
        this.players.set(playerId,player);this.roomCode=new URL(request.url).pathname.split("/").pop();
        server.send(JSON.stringify({type:"joined",playerId,roomCode:this.roomCode,host:isHost,phase:this.phase,settings:this.settings,message:isHost?"Room created! Share the code with friends.":"You joined the room!"}));
        this.broadcastState();await this.persist();return;
      }
      if(!playerId||!this.players.has(playerId))return;
      const player=this.players.get(playerId);
      if(msg.type==="settings"&&playerId===this.hostId&&this.phase!=="playing"){
        this.settings.radius=clamp(Number(msg.radius)||220,100,270);
        this.settings.pingInterval=clamp(Number(msg.pingInterval)||60,30,600);
        this.settings.seekersCount=clamp(Number(msg.seekersCount)||1,1,3);
        this.broadcastState("Settings saved.");await this.persist();
      } else if(msg.type==="start"&&playerId===this.hostId){
        if(this.players.size<2){this.sendOne(player,"error",{message:"You need at least 2 players to start."});return}
        const list=[...this.players.values()].sort(()=>Math.random()-.5);
        const count=Math.min(this.settings.seekersCount,list.length-1);
        list.forEach((p,i)=>{p.role=i<count?"seeker":"hider";p.alive=true;p.x=450+(Math.random()-.5)*100;p.y=300+(Math.random()-.5)*100});
        this.phase="playing";this.lastPing=Date.now();this.pings=[];
        this.broadcastState("Round started! Seekers, find everyone before time runs out.");await this.persist();
      } else if(msg.type==="end"&&playerId===this.hostId){
        this.phase="waiting";for(const p of this.players.values()){p.role="waiting";p.alive=true}
        this.broadcastState("Round ended. The host can start another round.");await this.persist();
      } else if(msg.type==="move"&&this.phase==="playing"&&player.alive){
        const speed=7,dx=clamp(Number(msg.dx)||0,-1,1),dy=clamp(Number(msg.dy)||0,-1,1);
        const cx=450,cy=300,rad=this.settings.radius*1.35;
        let nx=clamp(player.x+dx*speed,10,890),ny=clamp(player.y+dy*speed,10,590);
        const dist=Math.hypot(nx-cx,ny-cy);
        if(dist>rad){const a=Math.atan2(ny-cy,nx-cx);nx=cx+Math.cos(a)*rad;ny=cy+Math.sin(a)*rad}
        player.x=nx;player.y=ny;this.broadcastState();
        await this.maybePing();
      } else if(msg.type==="tag"&&this.phase==="playing"&&player.role==="seeker"){
        const target=[...this.players.values()].find(p=>p.role==="hider"&&p.alive&&Math.hypot(p.x-player.x,p.y-player.y)<36);
        if(target){target.alive=false;target.role="found";this.broadcastState(`${target.name} was found!`);const remaining=[...this.players.values()].some(p=>p.role==="hider"&&p.alive);if(!remaining){this.phase="waiting";this.broadcastState("Seekers win! All hiders were found.");for(const p of this.players.values())p.role="waiting";}await this.persist()}
      }
    });
    server.addEventListener("close",()=>this.removePlayer(playerId));
    server.addEventListener("error",()=>this.removePlayer(playerId));
    return new Response(null,{status:101,webSocket:client});
  }
  async maybePing(){
    const now=Date.now();if(this.phase!=="playing"||now-this.lastPing<this.settings.pingInterval*1000)return;
    this.lastPing=now;
    const hiders=[...this.players.values()].filter(p=>p.role==="hider"&&p.alive);
    for(const hider of hiders){
      // Broadcast only an approximate clue, not exact location; seekers see the clue for a few seconds.
      const ping={x:Math.round(hider.x/50)*50,y:Math.round(hider.y/50)*50,at:now};
      for(const p of this.players.values())if(p.role==="seeker")this.sendOne(p,"ping",{ping});
      this.pings.push(ping);
    }
    this.pings=this.pings.slice(-12);await this.persist();
  }
  sendOne(p,type,extra={}){try{p.ws.send(JSON.stringify({type,...extra}))}catch{}}
  broadcastState(message){
    const players=[...this.players.values()].map(p=>({id:p.id,name:p.name,role:p.role,x:p.x,y:p.y,alive:p.alive}));
    for(const p of this.players.values()){
      // Never send hider coordinates to seekers. Send only own coordinates for hiders and approximate pings.
      const visible=players.map(other=>{
        if(other.role==="hider"&&p.role==="seeker"&&other.id!==p.id)return {...other,x:450,y:300};
        return other;
      });
      this.sendOne(p,"state",{players:visible,phase:this.phase,settings:this.settings,hostId:this.hostId,pings:p.role==="seeker"?this.pings:[],message});
    }
  }
  async removePlayer(id){
    if(!id||!this.players.has(id))return;
    const p=this.players.get(id);this.players.delete(id);
    if(id===this.hostId){this.hostId=this.players.keys().next().value||null;if(this.hostId){const host=this.players.get(this.hostId);if(host)host.role="waiting"}}
    if(this.players.size===0){this.hostId=null;this.phase="waiting";this.ctx.storage.delete("room");}
    else{this.broadcastState(`${p.name} left the room.`);await this.persist()}
  }
  async persist(){await this.ctx.storage.put("room",{hostId:this.hostId,phase:this.phase,settings:this.settings,lastPing:this.lastPing,roomCode:this.roomCode,pings:this.pings})}
}
function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
