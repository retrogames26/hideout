export { GameRoom };

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const validCoord = (n, min, max) => Number.isFinite(Number(n)) && Number(n) >= min && Number(n) <= max;
const distanceMeters = (aLat, aLon, bLat, bLon) => {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4,6})$/i);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });
      const code = match[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
    this.hostId = null;
    this.phase = "waiting";
    this.settings = { radius: 500, pingInterval: 60, seekersCount: 1 };
    this.boundary = null;
    this.roomCode = null;
    this.pings = [];
    this.pendingCatches = new Map();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    let playerId = null;

    server.addEventListener("message", async event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "create" || msg.type === "join") {
        const name = String(msg.name || "Player").trim().slice(0, 18) || "Player";
        if (msg.type === "join" && this.players.size === 0) {
          server.send(JSON.stringify({ type: "error", message: "Room not found. Ask the host to create it first." }));
          return;
        }
        if (this.players.size >= 20) {
          server.send(JSON.stringify({ type: "error", message: "This room is full (20 players max)." }));
          return;
        }
        if (msg.type === "create" && this.players.size > 0) {
          server.send(JSON.stringify({ type: "error", message: "A room with that code already exists. Try creating another room." }));
          return;
        }
        if (this.players.size === 0) {
          this.hostId = null;
          this.phase = "waiting";
          this.boundary = null;
          this.pings = [];
          this.pendingCatches.clear();
        }
        playerId = crypto.randomUUID();
        const isHost = !this.hostId;
        if (isHost) this.hostId = playerId;
        const player = { id: playerId, name, role: "waiting", alive: true, ws: server, lat: null, lon: null, accuracy: null, outOfBounds: false };
        this.players.set(playerId, player);
        this.roomCode = new URL(request.url).pathname.split("/").pop().toUpperCase();
        server.send(JSON.stringify({
          type: "joined", playerId, roomCode: this.roomCode, host: isHost,
          phase: this.phase, settings: this.settings, boundary: this.boundary,
          message: isHost ? "Room created! Set a hiding zone and share the code with friends." : "You joined the room!"
        }));
        this.broadcastState();
        return;
      }

      if (!playerId || !this.players.has(playerId)) return;
      const player = this.players.get(playerId);

      if (msg.type === "settings" && playerId === this.hostId && this.phase !== "playing") {
        this.settings.radius = clamp(Number(msg.radius) || 500, 100, 2000);
        this.settings.pingInterval = clamp(Number(msg.pingInterval) || 60, 30, 600);
        this.settings.seekersCount = clamp(Number(msg.seekersCount) || 1, 1, 3);
        if (this.boundary) this.boundary.radius = this.settings.radius;
        this.broadcastState("Settings saved.");
      } else if (msg.type === "setBoundary" && playerId === this.hostId && this.phase !== "playing") {
        if (!validCoord(msg.lat, -90, 90) || !validCoord(msg.lon, -180, 180)) {
          this.sendOne(player, "error", { message: "Could not set the hiding zone. Check location permission and try again." });
          return;
        }
        this.settings.radius = clamp(Number(msg.radius) || this.settings.radius, 100, 2000);
        this.boundary = { lat: Number(msg.lat), lon: Number(msg.lon), radius: this.settings.radius };
        this.broadcastState("Hiding zone set. Hiders who leave it will trigger a seeker location ping.");
      } else if (msg.type === "start" && playerId === this.hostId) {
        if (this.players.size < 2) {
          this.sendOne(player, "error", { message: "You need at least 2 players to start." });
          return;
        }
        if (!this.boundary) {
          this.sendOne(player, "error", { message: "Set the hiding zone centre before starting." });
          return;
        }
        const list = [...this.players.values()].sort(() => Math.random() - 0.5);
        const count = Math.min(this.settings.seekersCount, list.length - 1);
        list.forEach((p, i) => {
          p.role = i < count ? "seeker" : "hider";
          p.alive = true;
          p.lat = null; p.lon = null; p.accuracy = null; p.outOfBounds = false;
        });
        this.phase = "playing";
        this.pings = [];
        this.broadcastState("Round started! Allow location access to share your live GPS position with this room.");
      } else if (msg.type === "end" && playerId === this.hostId) {
        this.finishRound("Round ended. Location sharing has stopped.");
      } else if (msg.type === "location" && this.phase === "playing" && player.alive) {
        if (!validCoord(msg.lat, -90, 90) || !validCoord(msg.lon, -180, 180)) return;
        const lat = Number(msg.lat), lon = Number(msg.lon);
        const accuracy = clamp(Number(msg.accuracy) || 100, 0, 10000);
        const outside = this.boundary
          ? distanceMeters(this.boundary.lat, this.boundary.lon, lat, lon) > this.boundary.radius
          : true;
        const boundaryChanged = player.outOfBounds !== outside;
        player.lat = lat;
        player.lon = lon;
        player.accuracy = accuracy;
        player.outOfBounds = outside;
        this.broadcastState(boundaryChanged ? (outside ? player.name + " left the hiding zone." : player.name + " returned to the hiding zone.") : undefined);
        // Crossing the hiding-zone boundary gives seekers a one-time approximate GPS ping.
        if (boundaryChanged && outside && player.role === "hider") {
          const ping = { lat: Number(lat.toFixed(3)), lon: Number(lon.toFixed(3)), at: Date.now(), reason: "hider-left-zone" };
          for (const seeker of this.players.values()) if (seeker.role === "seeker" && seeker.alive) this.sendOne(seeker, "ping", { ping, message: player.name + " left the hiding zone — location pinged!" });
        }
        await this.maybePing();
      } else if (msg.type === "tag" && this.phase === "playing" && player.role === "seeker") {
        if (player.lat == null || player.lon == null) {
          this.sendOne(player, "error", { message: "Enable GPS before tagging." });
          return;
        }
        const target = [...this.players.values()].find(p =>
          p.role === "hider" && p.alive && p.lat != null && p.lon != null &&
          distanceMeters(player.lat, player.lon, p.lat, p.lon) <= 15
        );
        if (target) {
          this.pendingCatches.set(target.id, { seekerId: player.id, requestedAt: Date.now() });
          this.sendOne(target, "catchRequest", { seekerName: player.name, message: player.name + " says they caught you. Confirm below if you were tagged." });
          this.sendOne(player, "tagged", { message: "Catch request sent. The hider must confirm they were caught." });
        } else {
          this.sendOne(player, "tagged", { message: "No hider close enough to tag. Get within 15 metres." });
        }
      } else if (msg.type === "confirmCaught" && this.phase === "playing" && player.role === "hider" && player.alive) {
        const pending = this.pendingCatches.get(player.id);
        if (!pending || Date.now() - pending.requestedAt > 30000) {
          this.pendingCatches.delete(player.id);
          this.sendOne(player, "error", { message: "No active catch request. Ask the seeker to try again nearby." });
          return;
        }
        player.alive = false;
        player.role = "found";
        this.pendingCatches.delete(player.id);
        this.broadcastState(player.name + " confirmed they were caught!");
        const remaining = [...this.players.values()].some(p => p.role === "hider" && p.alive);
        if (!remaining) this.finishRound("Seekers win! All hiders were found.");
      } else if (msg.type === "denyCaught" && this.phase === "playing" && player.role === "hider") {
        this.pendingCatches.delete(player.id);
        this.sendOne(player, "tagged", { message: "Catch request declined. A seeker must get within 15 metres and try again." });
      }
    });

    server.addEventListener("close", () => this.removePlayer(playerId));
    server.addEventListener("error", () => this.removePlayer(playerId));
    return new Response(null, { status: 101, webSocket: client });
  }

  finishRound(message) {
    this.phase = "waiting";
    this.pings = [];
    this.pendingCatches.clear();
    for (const p of this.players.values()) {
      p.role = "waiting";
      p.alive = true;
      p.lat = null; p.lon = null; p.accuracy = null; p.outOfBounds = false;
    }
    this.broadcastState(message);
  }

  async maybePing() {
    // Retain the configured clue interval as an optional seeker hint, without exposing exact coordinates outside the room.
    const now = Date.now();
    if (this.phase !== "playing" || !this.settings.pingInterval || !this.lastPing || now - this.lastPing < this.settings.pingInterval * 1000) {
      if (!this.lastPing) this.lastPing = now;
      return;
    }
    this.lastPing = now;
    const hiders = [...this.players.values()].filter(p => p.role === "hider" && p.alive && p.lat != null && p.lon != null);
    for (const hider of hiders) {
      const ping = { lat: Number(hider.lat.toFixed(3)), lon: Number(hider.lon.toFixed(3)), at: now };
      for (const p of this.players.values()) if (p.role === "seeker") this.sendOne(p, "ping", { ping });
      this.pings.push(ping);
    }
    this.pings = this.pings.slice(-12);
  }

  sendOne(p, type, extra = {}) {
    try { p.ws.send(JSON.stringify({ type, ...extra })); } catch {}
  }

  broadcastState(message) {
    const active = this.phase === "playing";
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, role: p.role, alive: p.alive,
      lat: active ? p.lat : null,
      lon: active ? p.lon : null,
      accuracy: active ? p.accuracy : null,
      outOfBounds: active ? p.outOfBounds : false
    }));
    for (const p of this.players.values()) {
      this.sendOne(p, "state", {
        players, phase: this.phase, settings: this.settings, hostId: this.hostId,
        boundary: this.boundary, pings: p.role === "seeker" && active ? this.pings : [], message
      });
    }
  }

  async removePlayer(id) {
    if (!id || !this.players.has(id)) return;
    const p = this.players.get(id);
    this.players.delete(id);
    if (id === this.hostId) this.hostId = this.players.keys().next().value || null;
    if (this.players.size === 0) {
      this.hostId = null;
      this.phase = "waiting";
      this.boundary = null;
      this.pings = [];
      this.pendingCatches.clear();
    } else {
      this.broadcastState(p.name + " left the room.");
    }
  }
}
