import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { WebSocket, WebSocketServer } from "ws"

import { ARENA, PLAYER_SPAWNS } from "../lib/game/arena"
import {
  type ClientMsg,
  DAMAGE,
  FIRE_INTERVAL_MS,
  KILLS_TO_WIN,
  MATCH_RESTART_MS,
  MAX_HP,
  MAX_PLAYERS,
  PLAYER_COLORS,
  type PlayerInfo,
  type PlayerState,
  RESPAWN_MS,
  type ServerMsg,
  TICK_MS,
  type Vec3,
  sanitizeName,
} from "../lib/game/protocol"

/* All state lives in memory: rooms vanish when their last player leaves. */

const EYE = 1.6
const HISTORY_MS = 600 // how far back hits are checked (lag compensation)
const MAX_MSGS_PER_SEC = 60

type Player = {
  id: string
  name: string
  color: number
  ws: WebSocket
  room: Room
  p: Vec3
  yaw: number
  pitch: number
  hp: number
  alive: boolean
  kills: number
  deaths: number
  lastShot: number
  history: { t: number; p: Vec3 }[]
  respawnTimer: ReturnType<typeof setTimeout> | null
  msgWindow: number
  msgCount: number
  isAlive: boolean // heartbeat
}

type Room = {
  code: string
  isPublic: boolean
  players: Map<string, Player>
  overUntil: number
  restartTimer: ReturnType<typeof setTimeout> | null
}

const rooms = new Map<string, Room>()
let nextId = 1

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("")
    if (!rooms.has(code)) return code
  }
}

function send(p: Player, msg: ServerMsg) {
  if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg))
}

function broadcast(room: Room, msg: ServerMsg, except?: Player) {
  const data = JSON.stringify(msg)
  for (const p of room.players.values()) {
    if (p !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(data)
  }
}

function info(p: Player): PlayerInfo {
  return { id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths }
}

function roster(room: Room) {
  broadcast(room, { t: "roster", players: [...room.players.values()].map(info) })
}

/** Spawn as far as possible from everyone still alive. */
function pickSpawn(room: Room, self?: Player): Vec3 {
  const others = [...room.players.values()].filter((o) => o !== self && o.alive)
  let best = PLAYER_SPAWNS[0]
  let bestScore = -1
  for (const s of PLAYER_SPAWNS) {
    const d = others.length ? Math.min(...others.map((o) => Math.hypot(o.p[0] - s[0], o.p[2] - s[1]))) : Math.random() * 100
    if (d > bestScore) {
      bestScore = d
      best = s
    }
  }
  return [best[0], 0, best[1]]
}

function respawn(p: Player) {
  p.respawnTimer = null
  if (!p.room.players.has(p.id)) return
  p.p = pickSpawn(p.room, p)
  p.hp = MAX_HP
  p.alive = true
  p.history = [{ t: Date.now(), p: p.p }]
  broadcast(p.room, { t: "respawn", id: p.id, p: p.p })
}

function closestRayDistance(o: Vec3, d: Vec3, c: Vec3) {
  const vx = c[0] - o[0]
  const vy = c[1] - o[1]
  const vz = c[2] - o[2]
  const t = vx * d[0] + vy * d[1] + vz * d[2]
  if (t < 0) return { dist: Infinity, t }
  const px = vx - d[0] * t
  const py = vy - d[1] * t
  const pz = vz - d[2] * t
  return { dist: Math.hypot(px, py, pz), t }
}

/** Was the target plausibly on this ray at some point in the recent past? */
function validateHit(shooter: Player, target: Player, o: Vec3, d: Vec3, part: "head" | "body") {
  const now = Date.now()
  // Shot must come from roughly where the shooter is
  if (Math.hypot(o[0] - shooter.p[0], o[1] - (shooter.p[1] + EYE), o[2] - shooter.p[2]) > 3) return false
  const samples = target.history.filter((h) => now - h.t <= HISTORY_MS)
  if (!samples.length) samples.push({ t: now, p: target.p })
  for (const { p } of samples) {
    const points: Vec3[] =
      part === "head"
        ? [[p[0], p[1] + 1.85, p[2]]]
        : [0.3, 0.7, 1.1, 1.5].map((y) => [p[0], p[1] + y, p[2]] as Vec3)
    const tolerance = part === "head" ? 0.6 : 0.9
    for (const c of points) {
      const { dist, t } = closestRayDistance(o, d, c)
      if (dist < tolerance && t < 160) return true
    }
  }
  return false
}

function finite(...n: unknown[]) {
  return n.every((v) => typeof v === "number" && Number.isFinite(v))
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && finite(...v)
}

function endMatch(room: Room, winner: Player) {
  room.overUntil = Date.now() + MATCH_RESTART_MS
  broadcast(room, { t: "match", state: "over", winner: winner.name, restartAt: room.overUntil })
  room.restartTimer = setTimeout(() => {
    room.restartTimer = null
    room.overUntil = 0
    for (const p of room.players.values()) {
      if (p.respawnTimer) clearTimeout(p.respawnTimer)
      p.kills = 0
      p.deaths = 0
      p.alive = false
    }
    broadcast(room, { t: "match", state: "live" })
    for (const p of room.players.values()) respawn(p)
    roster(room)
  }, MATCH_RESTART_MS)
}

function handleShot(p: Player, msg: Extract<ClientMsg, { t: "shot" }>) {
  const now = Date.now()
  const room = p.room
  if (!p.alive || room.overUntil) return
  if (now - p.lastShot < FIRE_INTERVAL_MS * 0.8) return // fire-rate limit
  if (!isVec3(msg.o) || !isVec3(msg.e)) return
  p.lastShot = now

  broadcast(room, { t: "shot", id: p.id, o: msg.o, e: msg.e }, p)

  if (!msg.hit) return
  const target = room.players.get(String(msg.hit.id))
  if (!target || target === p || !target.alive) return
  const part = msg.hit.part === "head" ? "head" : "body"
  const len = Math.hypot(msg.e[0] - msg.o[0], msg.e[1] - msg.o[1], msg.e[2] - msg.o[2])
  if (len < 1e-6) return
  const d: Vec3 = [(msg.e[0] - msg.o[0]) / len, (msg.e[1] - msg.o[1]) / len, (msg.e[2] - msg.o[2]) / len]
  if (!validateHit(p, target, msg.o, d, part)) return

  target.hp = Math.max(0, target.hp - DAMAGE[part])
  broadcast(room, { t: "hit", by: p.id, target: target.id, hp: target.hp, part })

  if (target.hp <= 0) {
    target.alive = false
    target.deaths++
    p.kills++
    broadcast(room, { t: "kill", killer: p.id, victim: target.id, head: part === "head" })
    roster(room)
    if (p.kills >= KILLS_TO_WIN) endMatch(room, p)
    else target.respawnTimer = setTimeout(() => respawn(target), RESPAWN_MS)
  }
}

function handleState(p: Player, msg: Extract<ClientMsg, { t: "state" }>) {
  if (!p.alive || !isVec3(msg.p) || !finite(msg.yaw, msg.pitch)) return
  const lim = ARENA - 0.3
  p.p = [Math.max(-lim, Math.min(lim, msg.p[0])), Math.max(0, Math.min(8, msg.p[1])), Math.max(-lim, Math.min(lim, msg.p[2]))]
  p.yaw = msg.yaw
  p.pitch = Math.max(-1.6, Math.min(1.6, msg.pitch))
  const now = Date.now()
  p.history.push({ t: now, p: p.p })
  while (p.history.length && now - p.history[0].t > HISTORY_MS) p.history.shift()
}

function join(ws: WebSocket, msg: Extract<ClientMsg, { t: "join" }>): Player | null {
  let room: Room | undefined
  if (msg.mode === "join") {
    room = rooms.get(String(msg.code ?? "").toUpperCase().trim())
    if (!room) {
      ws.send(JSON.stringify({ t: "error", message: "Room not found. Check the code and try again." } satisfies ServerMsg))
      return null
    }
    if (room.players.size >= MAX_PLAYERS) {
      ws.send(JSON.stringify({ t: "error", message: "That room is full." } satisfies ServerMsg))
      return null
    }
  } else if (msg.mode === "quick") {
    room = [...rooms.values()]
      .filter((r) => r.isPublic && r.players.size < MAX_PLAYERS)
      .sort((a, b) => b.players.size - a.players.size)[0]
  }
  if (!room) {
    room = { code: newCode(), isPublic: msg.mode === "quick", players: new Map(), overUntil: 0, restartTimer: null }
    rooms.set(room.code, room)
  }

  const used = new Set([...room.players.values()].map((p) => p.color))
  const player: Player = {
    id: String(nextId++),
    name: sanitizeName(msg.name),
    color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0],
    ws,
    room,
    p: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    hp: MAX_HP,
    alive: true,
    kills: 0,
    deaths: 0,
    lastShot: 0,
    history: [],
    respawnTimer: null,
    msgWindow: Date.now(),
    msgCount: 0,
    isAlive: true,
  }
  player.p = pickSpawn(room, player)
  player.history.push({ t: Date.now(), p: player.p })
  room.players.set(player.id, player)

  send(player, {
    t: "welcome",
    id: player.id,
    code: room.code,
    isPublic: room.isPublic,
    spawn: player.p,
    players: [...room.players.values()].map(info),
  })
  roster(room)
  if (room.overUntil) send(player, { t: "match", state: "over", winner: "", restartAt: room.overUntil })
  return player
}

function leave(p: Player) {
  const room = p.room
  if (p.respawnTimer) clearTimeout(p.respawnTimer)
  room.players.delete(p.id)
  if (room.players.size === 0) {
    if (room.restartTimer) clearTimeout(room.restartTimer)
    rooms.delete(room.code)
  } else {
    roster(room)
  }
}

export function createGameServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 })

  wss.on("connection", (ws) => {
    let player: Player | null = null
    const joinTimeout = setTimeout(() => !player && ws.close(), 10_000)

    ws.on("message", (raw) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!msg || typeof msg !== "object") return

      if (!player) {
        if (msg.t === "join") {
          player = join(ws, msg)
          if (player) clearTimeout(joinTimeout)
        }
        return
      }

      // Simple flood protection
      const now = Date.now()
      if (now - player.msgWindow > 1000) {
        player.msgWindow = now
        player.msgCount = 0
      }
      if (++player.msgCount > MAX_MSGS_PER_SEC) return

      if (msg.t === "state") handleState(player, msg)
      else if (msg.t === "shot") handleShot(player, msg)
      else if (msg.t === "ping" && finite(msg.ts)) send(player, { t: "pong", ts: msg.ts })
    })

    ws.on("pong", () => {
      if (player) player.isAlive = true
    })
    ws.on("close", () => {
      clearTimeout(joinTimeout)
      if (player) leave(player)
    })
    ws.on("error", () => ws.terminate())
  })

  // Snapshots
  const tick = setInterval(() => {
    for (const room of rooms.values()) {
      const s: PlayerState[] = [...room.players.values()].map((p) => ({
        id: p.id,
        p: p.p,
        yaw: p.yaw,
        pitch: p.pitch,
        hp: p.hp,
        alive: p.alive,
      }))
      broadcast(room, { t: "snap", s })
    }
  }, TICK_MS)

  // Drop dead connections
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const p of room.players.values()) {
        if (!p.isAlive) {
          p.ws.terminate()
          continue
        }
        p.isAlive = false
        p.ws.ping()
      }
    }
  }, 15_000)

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    },
    close() {
      clearInterval(tick)
      clearInterval(heartbeat)
      wss.close()
    },
    stats() {
      return { rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }
    },
  }
}
