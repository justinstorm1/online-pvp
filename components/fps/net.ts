import { type ClientMsg, type JoinRequest, type ServerMsg, WS_PATH } from "@/lib/game/protocol"

type Listener = (msg: ServerMsg) => void

function socketUrl() {
  // Override when the game server is hosted separately from the page
  const configured = process.env.NEXT_PUBLIC_GAME_SERVER_URL
  if (configured) return configured
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${location.host}${WS_PATH}`
}

export class NetClient {
  private ws: WebSocket
  private listeners = new Set<Listener>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  id: string | null = null
  ping = 0
  closedReason: string | null = null

  constructor(
    name: string,
    request: JoinRequest,
    private onClose: (reason: string) => void
  ) {
    this.ws = new WebSocket(socketUrl())
    this.ws.addEventListener("open", () => {
      this.send({ t: "join", name, ...request })
      this.pingTimer = setInterval(() => this.send({ t: "ping", ts: performance.now() }), 2000)
    })
    this.ws.addEventListener("message", (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (msg.t === "welcome") this.id = msg.id
      if (msg.t === "pong") this.ping = Math.round(performance.now() - msg.ts)
      for (const l of this.listeners) l(msg)
    })
    this.ws.addEventListener("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      if (!this.closedReason) {
        this.closedReason = this.id ? "Disconnected from the game server." : "Couldn’t reach the game server."
        this.onClose(this.closedReason)
      }
    })
  }

  on(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  close() {
    this.closedReason = "left"
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.listeners.clear()
    this.ws.close()
  }
}
