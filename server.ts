import { createServer } from "node:http"
import { parse } from "node:url"

import next from "next"

import { WS_PATH } from "./lib/game/protocol"
import { createGameServer } from "./server/game-server"

/* One process serves the Next.js app and the multiplayer WebSocket on the same port. */

const port = parseInt(process.env.PORT || "3000", 10)
const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "0.0.0.0"

const app = next({ dev, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const game = createGameServer()
  const nextUpgrade = app.getUpgradeHandler()

  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ ok: true, ...game.stats() }))
      return
    }
    handle(req, res, parse(req.url ?? "/", true))
  })

  server.on("upgrade", (req, socket, head) => {
    if (parse(req.url ?? "/").pathname === WS_PATH) game.handleUpgrade(req, socket, head)
    else void nextUpgrade(req, socket, head) // e.g. dev hot reload
  })

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://localhost:${port} (${dev ? "development" : "production"}) — game socket at ${WS_PATH}`)
  })

  const shutdown = () => {
    game.close()
    server.close(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
})
