"use client"

import { useEffect, useRef, useState } from "react"

import { KILLS_TO_WIN, type JoinRequest, type PlayerInfo, type ServerMsg } from "@/lib/game/protocol"

import type { FPSGame, GameResult, HudState } from "./engine"
import { NetClient } from "./net"

type View = "menu" | "solo" | "online"
type SoloPhase = "playing" | "paused" | "over"

type Feed = { id: number; killer: string; victim: string; head: boolean; mine: boolean; at: number }

const BEST_KEY = "last-stand:best"
const NAME_KEY = "last-stand:name"

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked (private mode etc.) — just won't persist
  }
}

const hex = (c: number) => "#" + c.toString(16).padStart(6, "0")

export function Game() {
  const mountRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<FPSGame | null>(null)
  const netRef = useRef<NetClient | null>(null)
  const viewRef = useRef<View>("menu")
  const soloRef = useRef<SoloPhase>("paused")

  const [view, setViewState] = useState<View>("menu")
  const [locked, setLocked] = useState(false)
  const [solo, setSoloState] = useState<SoloPhase>("paused")
  const [hud, setHud] = useState<HudState | null>(null)
  const [hit, setHit] = useState<{ id: number; kill: boolean; head: boolean } | null>(null)
  const [hurt, setHurt] = useState<{ id: number; angle: number } | null>(null)
  const [banner, setBanner] = useState<{ id: number; text: string } | null>(null)
  const [result, setResult] = useState<GameResult | null>(null)
  const [best, setBest] = useState<GameResult | null>(null)
  const [newBest, setNewBest] = useState(false)
  const [touchOnly, setTouchOnly] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Online
  const [name, setName] = useState("")
  const [joinCode, setJoinCode] = useState("")
  const [room, setRoom] = useState<{ code: string; isPublic: boolean } | null>(null)
  const [myId, setMyId] = useState<string | null>(null)
  const [players, setPlayers] = useState<PlayerInfo[]>([])
  const [feed, setFeed] = useState<Feed[]>([])
  const [death, setDeath] = useState<{ killer: string; until: number } | null>(null)
  const [match, setMatch] = useState<{ winner: string; until: number } | null>(null)
  const [netError, setNetError] = useState<string | null>(null)
  const [showBoard, setShowBoard] = useState(false)
  const [ping, setPing] = useState(0)
  const [now, setNow] = useState(0)
  const [copied, setCopied] = useState(false)

  const setView = (v: View) => {
    viewRef.current = v
    setViewState(v)
  }
  const setSolo = (p: SoloPhase) => {
    soloRef.current = p
    setSoloState(p)
  }

  useEffect(() => {
    let cancelled = false
    let n = 0
    import("./engine")
      .then(({ FPSGame }) => {
        if (cancelled || !mountRef.current) return
        setBest(readJSON<GameResult>(BEST_KEY))
        setName(readJSON<string>(NAME_KEY) ?? "")
        setJoinCode(new URLSearchParams(location.search).get("room")?.toUpperCase().slice(0, 4) ?? "")
        setTouchOnly(window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches)
        gameRef.current = new FPSGame(mountRef.current, {
          onHud: setHud,
          onHit: (head, kill) => setHit({ id: ++n, head, kill }),
          onDamage: (angle) => setHurt({ id: ++n, angle }),
          onWave: (wave) => setBanner({ id: ++n, text: `Wave ${wave}` }),
          onPickup: (amount) => setBanner({ id: ++n, text: `+${amount} Health` }),
          onLock: (isLocked) => {
            setLocked(isLocked)
            if (viewRef.current === "solo" && soloRef.current !== "over") setSolo(isLocked ? "playing" : "paused")
          },
          onGameOver: (r) => {
            setResult(r)
            const prev = readJSON<GameResult>(BEST_KEY)
            const isBest = r.score > 0 && (!prev || r.score > prev.score)
            setNewBest(isBest)
            if (isBest) {
              writeJSON(BEST_KEY, r)
              setBest(r)
            }
            setSolo("over")
          },
        })
        setReady(true)
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "WebGL is not available in this browser.")
      })

    return () => {
      cancelled = true
      netRef.current?.close()
      gameRef.current?.dispose()
      gameRef.current = null
    }
  }, [])

  // Clock for countdowns and feed expiry
  useEffect(() => {
    if (view !== "online") return
    const t = setInterval(() => {
      setNow(Date.now())
      setPing(netRef.current?.ping ?? 0)
    }, 250)
    return () => clearInterval(t)
  }, [view])

  // Hold Tab for the scoreboard
  useEffect(() => {
    if (view !== "online") return
    const down = (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        e.preventDefault()
        setShowBoard(true)
      }
    }
    const up = (e: KeyboardEvent) => e.code === "Tab" && setShowBoard(false)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [view])

  /* ----- Actions ----- */

  const startSolo = () => {
    setHud(null)
    setResult(null)
    setView("solo")
    setSolo("paused")
    gameRef.current?.startSolo()
  }

  const toMenu = () => {
    gameRef.current?.leaveOnline()
    setView("menu")
  }

  const startOnline = (request: JoinRequest) => {
    const game = gameRef.current
    if (!game) return
    const playerName = name.trim()
    writeJSON(NAME_KEY, playerName)
    setNetError(null)
    setPlayers([])
    setFeed([])
    setDeath(null)
    setMatch(null)
    setRoom(null)
    setMyId(null)
    setHud(null)

    let feedId = 0
    const net = new NetClient(playerName, request, (reason) => {
      setNetError(reason)
      if (document.pointerLockElement) document.exitPointerLock()
    })
    let roster: PlayerInfo[] = []
    const nameOf = (id: string) => roster.find((p) => p.id === id)?.name ?? "Someone"
    net.on((msg: ServerMsg) => {
      switch (msg.t) {
        case "welcome":
          setMyId(msg.id)
          setRoom({ code: msg.code, isPublic: msg.isPublic })
          if (!msg.isPublic) history.replaceState(null, "", `?room=${msg.code}`)
          break
        case "roster":
          roster = msg.players
          setPlayers(msg.players)
          break
        case "kill":
          setFeed((f) =>
            [
              ...f,
              {
                id: ++feedId,
                killer: nameOf(msg.killer),
                victim: nameOf(msg.victim),
                head: msg.head,
                mine: msg.killer === net.id || msg.victim === net.id,
                at: Date.now(),
              },
            ].slice(-6)
          )
          if (msg.victim === net.id) setDeath({ killer: nameOf(msg.killer), until: Date.now() + 3000 })
          break
        case "respawn":
          if (msg.id === net.id) setDeath(null)
          break
        case "match":
          if (msg.state === "over") {
            setMatch({ winner: msg.winner, until: msg.restartAt })
            setDeath(null)
          } else {
            setMatch(null)
            setFeed([])
          }
          break
        case "error":
          net.closedReason = msg.message
          setNetError(msg.message)
          if (document.pointerLockElement) document.exitPointerLock()
          break
      }
    })
    netRef.current?.close()
    netRef.current = net
    setView("online")
    game.startOnline(net)
  }

  const leaveOnline = () => {
    netRef.current?.close()
    netRef.current = null
    history.replaceState(null, "", location.pathname)
    setNetError(null)
    setRoom(null)
    toMenu()
  }

  const copyInvite = async () => {
    if (!room) return
    const url = `${location.origin}${location.pathname}?room=${room.code}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      prompt("Copy this invite link:", url)
    }
  }

  /* ----- Derived ----- */

  const sorted = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  const me = players.find((p) => p.id === myId)
  const leader = sorted[0]
  const inOnline = view === "online"
  const showHud = hud && ((view === "solo" && solo !== "over") || (inOnline && !netError))
  const recentFeed = feed.filter((f) => now === 0 || now - f.at < 6000)

  const scoreboard = (
    <div className="w-full max-w-lg overflow-hidden rounded-xl bg-black/70 ring-1 ring-white/15 backdrop-blur-md">
      <div className="flex items-center justify-between px-4 py-3 text-xs tracking-[0.2em] text-white/60 uppercase">
        <span>
          {room?.isPublic ? "Public match" : `Room ${room?.code ?? ""}`} · first to {KILLS_TO_WIN}
        </span>
        <span>{players.length}/8</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] tracking-[0.2em] text-white/50 uppercase">
            <th className="px-4 py-1 font-normal">Player</th>
            <th className="w-16 py-1 text-right font-normal">Kills</th>
            <th className="w-20 px-4 py-1 text-right font-normal">Deaths</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.id} className={p.id === myId ? "bg-white/10" : ""}>
              <td className="px-4 py-2 text-left">
                <span className="mr-2 inline-block size-2.5 rounded-full" style={{ background: hex(p.color) }} />
                {p.name}
                {p.id === myId && <span className="ml-2 text-white/50">(you)</span>}
              </td>
              <td className="py-2 text-right font-bold tabular-nums">{p.kills}</td>
              <td className="px-4 py-2 text-right text-white/70 tabular-nums">{p.deaths}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  const secondsLeft = (until: number) => (now ? Math.max(0, Math.ceil((until - now) / 1000)) : "")

  return (
    <div className="relative h-svh w-full overflow-hidden bg-[#3a4a66] font-mono text-white select-none">
      <div ref={mountRef} className="absolute inset-0" />

      {showHud && (
        <div className="pointer-events-none absolute inset-0">
          {hurt && (
            <div key={hurt.id} className="fps-hurt absolute inset-0">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(220,20,40,0.55))]" />
              <div className="absolute inset-0 flex items-center justify-center" style={{ transform: `rotate(${hurt.angle}rad)` }}>
                <div className="h-[46vmin] w-[46vmin] rounded-full border-t-[6px] border-[#ff2a44] opacity-90 [mask-image:linear-gradient(to_bottom,black_20%,transparent_45%)]" />
              </div>
            </div>
          )}
          {hud.health <= 30 && !hud.dead && (
            <div className="fps-pulse absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(180,0,20,0.45))]" />
          )}

          {/* Crosshair */}
          {!hud.dead && (
            <div className="absolute top-1/2 left-1/2 size-0">
              <span className="absolute -top-px left-[6px] h-[2px] w-[10px] bg-white/90 shadow-[0_0_2px_#000]" />
              <span className="absolute -top-px right-[6px] h-[2px] w-[10px] bg-white/90 shadow-[0_0_2px_#000]" />
              <span className="absolute top-[6px] -left-px h-[10px] w-[2px] bg-white/90 shadow-[0_0_2px_#000]" />
              <span className="absolute bottom-[6px] -left-px h-[10px] w-[2px] bg-white/90 shadow-[0_0_2px_#000]" />
              {hit && (
                <div key={hit.id} className="fps-hit absolute -top-[14px] -left-[14px] size-[28px]">
                  {[45, -45].map((r) => (
                    <span
                      key={r}
                      className={`absolute top-1/2 left-1/2 h-[2px] w-[34px] -translate-1/2 ${hit.kill ? "bg-[#ff3344]" : hit.head ? "bg-[#ffd23f]" : "bg-white"}`}
                      style={{ rotate: `${r}deg` }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Top: mode-specific */}
          {hud.mode === "solo" ? (
            <>
              <div className="absolute top-5 left-1/2 -translate-x-1/2 text-center [text-shadow:0_2px_8px_rgba(0,0,0,0.7)]">
                <div className="text-xs tracking-[0.3em] text-white/60 uppercase">Wave</div>
                <div className="text-4xl font-bold">{hud.wave || "—"}</div>
                <div className="mt-1 text-xs text-white/70">{hud.enemiesLeft} hostiles</div>
              </div>
              <div className="absolute top-5 right-6 text-right [text-shadow:0_2px_8px_rgba(0,0,0,0.7)]">
                <div className="text-xs tracking-[0.3em] text-white/60 uppercase">Score</div>
                <div className="text-3xl font-bold tabular-nums">{hud.score.toLocaleString()}</div>
                <div className="text-xs text-white/70">{hud.kills} kills</div>
              </div>
            </>
          ) : (
            <>
              <div className="absolute top-5 left-6 text-xs text-white/75 [text-shadow:0_2px_8px_rgba(0,0,0,0.7)]">
                {room ? (
                  <>
                    <div className="tracking-[0.2em] uppercase">{room.isPublic ? "Public match" : `Room ${room.code}`}</div>
                    <div className="mt-1 text-white/55">
                      {players.length} player{players.length === 1 ? "" : "s"} · {ping} ms · Tab: scores
                    </div>
                  </>
                ) : (
                  <div className="animate-pulse tracking-[0.2em] uppercase">Connecting…</div>
                )}
              </div>
              <div className="absolute top-5 left-1/2 -translate-x-1/2 text-center [text-shadow:0_2px_8px_rgba(0,0,0,0.7)]">
                <div className="text-xs tracking-[0.3em] text-white/60 uppercase">Kills</div>
                <div className="text-4xl font-bold tabular-nums">
                  {me?.kills ?? 0}
                  <span className="text-lg text-white/50"> / {KILLS_TO_WIN}</span>
                </div>
                {leader && leader.kills > 0 && (
                  <div className="mt-1 text-xs text-white/70">
                    {leader.id === myId ? "You lead" : `${leader.name} leads with ${leader.kills}`}
                  </div>
                )}
              </div>
              <div className="absolute top-5 right-6 flex w-[min(340px,40vw)] flex-col items-end gap-1.5">
                {recentFeed.map((f) => (
                  <div key={f.id} className={`rounded px-2.5 py-1 text-xs ${f.mine ? "bg-[#ff3344]/70" : "bg-black/50"}`}>
                    <span className="font-bold">{f.killer}</span>
                    <span className="mx-2 text-white/70">{f.head ? "⌖ headshot" : "→"}</span>
                    <span className="font-bold">{f.victim}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Health */}
          <div className="absolute bottom-6 left-6 w-[min(320px,40vw)] [text-shadow:0_2px_8px_rgba(0,0,0,0.7)]">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold tabular-nums">{hud.health}</span>
              <span className="text-xs tracking-[0.3em] text-white/60 uppercase">Health</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/50 ring-1 ring-white/15">
              <div
                className={`h-full rounded-full transition-[width] duration-200 ${hud.health > 30 ? "bg-[#3ee08f]" : "bg-[#ff3b4e]"}`}
                style={{ width: `${hud.health}%` }}
              />
            </div>
          </div>

          {/* Ammo */}
          {!hud.dead && (
            <div className="absolute right-6 bottom-6 text-right [text-shadow:0_2px_8px_rgba(0,0,0,0.7)]">
              {hud.reloading ? (
                <div className="animate-pulse text-xl font-bold tracking-[0.2em] text-[#2ad4ff]">RELOADING</div>
              ) : (
                <div className="flex items-baseline justify-end gap-1">
                  <span className={`text-5xl font-bold tabular-nums ${hud.ammo <= 3 ? "text-[#ff3b4e]" : ""}`}>{hud.ammo}</span>
                  <span className="text-lg text-white/50">/ {hud.magSize}</span>
                </div>
              )}
              <div className="mt-2 flex justify-end gap-[3px]">
                {Array.from({ length: hud.magSize }, (_, i) => (
                  <span key={i} className={`h-3 w-[5px] rounded-[1px] ${i < hud.ammo && !hud.reloading ? "bg-[#ffd27a]" : "bg-white/15"}`} />
                ))}
              </div>
              {hud.ammo === 0 && !hud.reloading && <div className="mt-1 text-xs text-[#ff3b4e]">Press R to reload</div>}
            </div>
          )}

          {banner && hud.mode === "solo" && (
            <div key={banner.id} className="fps-banner absolute top-[28%] left-1/2 -translate-x-1/2 text-5xl font-black tracking-[0.15em] uppercase [text-shadow:0_4px_24px_rgba(0,0,0,0.8)]">
              {banner.text}
            </div>
          )}

          {/* Online: death, match end, scoreboard */}
          {inOnline && death && !match && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[radial-gradient(ellipse_at_center,rgba(80,0,10,0.35),rgba(40,0,5,0.75))] text-center">
              <div className="text-xs tracking-[0.3em] text-white/70 uppercase">Eliminated by</div>
              <div className="mt-2 text-4xl font-black">{death.killer}</div>
              <div className="mt-6 text-sm text-white/80">Respawning in {secondsLeft(death.until)}…</div>
            </div>
          )}
          {inOnline && match && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/60 p-6 text-center backdrop-blur-sm">
              <div>
                <div className="text-xs tracking-[0.3em] text-white/70 uppercase">Match over</div>
                <div className="mt-2 text-5xl font-black text-[#ffd23f]">
                  {match.winner ? (match.winner === me?.name ? "You win!" : `${match.winner} wins`) : "Round ending"}
                </div>
              </div>
              {scoreboard}
              <div className="text-sm text-white/80">Next match in {secondsLeft(match.until)}…</div>
            </div>
          )}
          {inOnline && showBoard && !match && locked && (
            <div className="absolute inset-0 flex items-center justify-center p-6">{scoreboard}</div>
          )}
        </div>
      )}

      {/* ----- Menus ----- */}
      {(view === "menu" || (view === "solo" && solo !== "playing") || (inOnline && (!locked || netError))) && (
        <div className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-black/55 p-6 backdrop-blur-sm">
          <div className="w-full max-w-md text-center">
            {loadError ? (
              <p className="rounded-lg bg-[#ff3344]/20 p-4 text-sm">Couldn’t start the game: {loadError}</p>
            ) : touchOnly ? (
              <>
                <Title />
                <p className="mt-8 rounded-lg bg-white/10 p-4 text-sm">
                  This game needs a keyboard and mouse. Open it on a desktop or laptop to play.
                </p>
              </>
            ) : view === "menu" ? (
              <MainMenu
                ready={ready}
                name={name}
                setName={setName}
                joinCode={joinCode}
                setJoinCode={setJoinCode}
                onQuick={() => startOnline({ mode: "quick" })}
                onCreate={() => startOnline({ mode: "create" })}
                onJoin={() => startOnline({ mode: "join", code: joinCode })}
                onSolo={startSolo}
                best={best}
              />
            ) : view === "solo" ? (
              <>
                {solo === "paused" && <h2 className="text-5xl font-black tracking-tight">PAUSED</h2>}
                {solo === "over" && result && (
                  <>
                    <h2 className="text-6xl font-black tracking-tight text-[#ff3344]">K.I.A.</h2>
                    {newBest && <p className="mt-2 text-sm font-bold tracking-[0.2em] text-[#ffd23f]">NEW BEST SCORE</p>}
                    <div className="mt-6 grid grid-cols-3 gap-3">
                      {(
                        [
                          ["Score", result.score.toLocaleString()],
                          ["Wave", result.wave],
                          ["Kills", result.kills],
                        ] as const
                      ).map(([k, v]) => (
                        <div key={k} className="rounded-lg bg-white/10 px-3 py-3">
                          <div className="text-[10px] tracking-[0.25em] text-white/60 uppercase">{k}</div>
                          <div className="mt-1 text-2xl font-bold tabular-nums">{v}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <PrimaryButton onClick={() => (solo === "over" ? startSolo() : gameRef.current?.resume())}>
                  {solo === "over" ? "Play again" : "Resume"}
                </PrimaryButton>
                <button type="button" onClick={toMenu} className="mt-4 block w-full text-sm text-white/70 hover:text-white">
                  Main menu
                </button>
              </>
            ) : netError ? (
              <>
                <h2 className="text-4xl font-black tracking-tight text-[#ff3344]">Can’t play online</h2>
                <p className="mt-3 text-sm text-white/80">{netError}</p>
                <PrimaryButton onClick={leaveOnline}>Back to menu</PrimaryButton>
              </>
            ) : (
              <>
                <h2 className="text-5xl font-black tracking-tight">PAUSED</h2>
                <p className="mt-2 text-sm text-white/70">You’re still in the match — other players can see you.</p>
                <PrimaryButton onClick={() => gameRef.current?.resume()}>Resume</PrimaryButton>
                {room && !room.isPublic && (
                  <div className="mt-6 rounded-xl bg-white/10 p-4">
                    <div className="text-xs tracking-[0.2em] text-white/60 uppercase">Invite friends</div>
                    <div className="mt-1 text-3xl font-black tracking-[0.3em]">{room.code}</div>
                    <button
                      type="button"
                      onClick={copyInvite}
                      className="mt-3 rounded-full bg-white/15 px-4 py-2 text-xs font-bold tracking-[0.15em] uppercase hover:bg-white/25"
                    >
                      {copied ? "Link copied" : "Copy invite link"}
                    </button>
                  </div>
                )}
                {players.length > 0 && <div className="mt-6 flex justify-center">{scoreboard}</div>}
                <button type="button" onClick={leaveOnline} className="mt-6 text-sm text-white/70 hover:text-white">
                  Leave match
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Title() {
  return (
    <>
      <h1 className="text-6xl font-black tracking-tight italic">
        LAST <span className="text-[#ff3344]">STAND</span>
      </h1>
      <p className="mt-3 text-sm text-white/70">Free-for-all arena combat. First to {KILLS_TO_WIN} kills wins.</p>
    </>
  )
}

function PrimaryButton({ onClick, children, disabled }: { onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-8 w-full rounded-full bg-[#ff3344] px-10 py-4 text-lg font-bold tracking-[0.15em] uppercase shadow-[0_8px_30px_rgba(255,51,68,0.45)] transition-transform duration-100 hover:bg-[#ff4a59] active:scale-95 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function MainMenu(props: {
  ready: boolean
  name: string
  setName: (v: string) => void
  joinCode: string
  setJoinCode: (v: string) => void
  onQuick: () => void
  onCreate: () => void
  onJoin: () => void
  onSolo: () => void
  best: GameResult | null
}) {
  const { ready, name, setName, joinCode, setJoinCode, onQuick, onCreate, onJoin, onSolo, best } = props
  return (
    <>
      <Title />
      <label className="mt-8 block text-left text-xs tracking-[0.2em] text-white/60 uppercase">
        Your name
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          placeholder="Player"
          maxLength={16}
          className="mt-2 block w-full rounded-lg border border-white/20 bg-black/40 px-4 py-3 text-base tracking-normal text-white normal-case outline-none placeholder:text-white/30 focus:border-[#ff3344]"
        />
      </label>

      {joinCode.length === 4 ? (
        <PrimaryButton onClick={onJoin} disabled={!ready}>
          Join room {joinCode}
        </PrimaryButton>
      ) : (
        <PrimaryButton onClick={onQuick} disabled={!ready}>
          Quick match
        </PrimaryButton>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onCreate}
          disabled={!ready}
          className="rounded-full bg-white/15 px-4 py-3 text-xs font-bold tracking-[0.15em] uppercase hover:bg-white/25 disabled:opacity-50"
        >
          Create private room
        </button>
        <form
          className="flex rounded-full bg-white/15 p-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (joinCode.length === 4) onJoin()
          }}
        >
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))}
            placeholder="CODE"
            aria-label="Room code"
            className="w-full min-w-0 bg-transparent px-3 text-center text-sm font-bold tracking-[0.3em] outline-none placeholder:text-white/30"
          />
          <button
            type="submit"
            disabled={!ready || joinCode.length !== 4}
            className="rounded-full bg-white/20 px-3 py-2 text-xs font-bold uppercase hover:bg-white/30 disabled:opacity-40"
          >
            Join
          </button>
        </form>
      </div>
      {joinCode.length === 4 && (
        <button type="button" onClick={onQuick} disabled={!ready} className="mt-3 text-xs text-white/60 hover:text-white">
          or play a public quick match
        </button>
      )}

      <button
        type="button"
        onClick={onSolo}
        disabled={!ready}
        className="mt-5 block w-full text-sm text-white/70 underline-offset-4 hover:text-white hover:underline"
      >
        Solo practice vs bots
      </button>

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-2 text-left text-xs text-white/75">
        {[
          ["WASD", "Move"],
          ["Mouse", "Aim"],
          ["Click", "Shoot (hold)"],
          ["R", "Reload"],
          ["Shift", "Sprint"],
          ["Space", "Jump"],
          ["Tab", "Scoreboard"],
          ["Esc", "Pause"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <kbd className="min-w-14 rounded border border-white/25 bg-white/10 px-2 py-0.5 text-center">{k}</kbd>
            <span>{v}</span>
          </div>
        ))}
      </div>

      {best && (
        <p className="mt-6 text-xs text-white/50">
          Solo best: {best.score.toLocaleString()} pts · wave {best.wave}
        </p>
      )}
    </>
  )
}
