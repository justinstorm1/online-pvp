/** Wire protocol between browser and game server (JSON over WebSocket at /ws). */

export const WS_PATH = "/ws"
export const TICK_MS = 50 // 20 Hz snapshots and client state updates
export const MAX_PLAYERS = 8
export const KILLS_TO_WIN = 20
export const RESPAWN_MS = 3000
export const MATCH_RESTART_MS = 10000
export const FIRE_INTERVAL_MS = 140
export const MAX_HP = 100
export const DAMAGE = { body: 25, head: 75 } as const

export type Vec3 = [number, number, number]
export type HitPart = "head" | "body"

export type PlayerInfo = {
  id: string
  name: string
  color: number
  kills: number
  deaths: number
}

export type PlayerState = {
  id: string
  p: Vec3
  yaw: number
  pitch: number
  hp: number
  alive: boolean
}

export type JoinRequest = { mode: "quick" } | { mode: "create" } | { mode: "join"; code: string }

export type ClientMsg =
  | ({ t: "join"; name: string } & JoinRequest)
  | { t: "state"; p: Vec3; yaw: number; pitch: number }
  | { t: "shot"; o: Vec3; e: Vec3; hit: { id: string; part: HitPart } | null }
  | { t: "ping"; ts: number }

export type ServerMsg =
  | { t: "welcome"; id: string; code: string; isPublic: boolean; spawn: Vec3; players: PlayerInfo[] }
  | { t: "error"; message: string }
  | { t: "roster"; players: PlayerInfo[] }
  | { t: "snap"; s: PlayerState[] }
  | { t: "shot"; id: string; o: Vec3; e: Vec3 }
  | { t: "hit"; by: string; target: string; hp: number; part: HitPart }
  | { t: "kill"; killer: string; victim: string; head: boolean }
  | { t: "respawn"; id: string; p: Vec3 }
  | { t: "match"; state: "over"; winner: string; restartAt: number }
  | { t: "match"; state: "live" }
  | { t: "pong"; ts: number }

export const PLAYER_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xf59e0b, 0xa855f7, 0x06b6d4, 0xec4899, 0xf97316]

export function sanitizeName(raw: unknown) {
  const name = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 16) : ""
  return name || `Player${Math.floor(Math.random() * 900 + 100)}`
}
