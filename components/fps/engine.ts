import * as THREE from "three"

import { ARENA, BOXES, ENEMY_SPAWNS } from "@/lib/game/arena"
import { MAX_HP, type ServerMsg, TICK_MS, type Vec3 } from "@/lib/game/protocol"

import { Sfx } from "./audio"
import type { NetClient } from "./net"

export type HudState = {
  mode: "solo" | "online"
  dead: boolean
  health: number
  ammo: number
  magSize: number
  reloading: boolean
  wave: number
  score: number
  kills: number
  enemiesLeft: number
}

export type GameResult = { score: number; wave: number; kills: number }

export type GameEvents = {
  onHud: (s: HudState) => void
  onHit: (headshot: boolean, kill: boolean) => void
  /** Angle (radians) of the attacker relative to where the player looks; 0 = straight ahead. */
  onDamage: (angle: number) => void
  onWave: (wave: number) => void
  onPickup: (amount: number) => void
  onGameOver: (r: GameResult) => void
  onLock: (locked: boolean) => void
}

/* ---------- Tuning ---------- */

const EYE = 1.6
const PLAYER_R = 0.4
const WALK = 6
const SPRINT = 9.5
const GRAVITY = 22
const JUMP_V = 7.5
const MAG = 12
const FIRE_INTERVAL = 0.14
const RELOAD_TIME = 1.2
const MAX_HEALTH = 100

type EnemyKind = "grunt" | "rusher"

const ENEMY = {
  grunt: { hp: 4, speed: 2.6, radius: 0.45, score: 100, scale: 1 },
  rusher: { hp: 2, speed: 5.6, radius: 0.38, score: 150, scale: 0.82 },
} as const

/* ---------- Helpers ---------- */

type Box = { minX: number; maxX: number; minZ: number; maxZ: number; h: number }

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement("canvas")
  c.width = c.height = size
  draw(c.getContext("2d")!, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

function floorTexture() {
  return canvasTexture(256, (g, s) => {
    g.fillStyle = "#2b313a"
    g.fillRect(0, 0, s, s)
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2)
    }
    g.strokeStyle = "#3d4652"
    g.lineWidth = 4
    g.strokeRect(0, 0, s, s)
    g.strokeStyle = "#343c47"
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(s / 2, 0)
    g.lineTo(s / 2, s)
    g.moveTo(0, s / 2)
    g.lineTo(s, s / 2)
    g.stroke()
  })
}

function crateTexture() {
  return canvasTexture(256, (g, s) => {
    g.fillStyle = "#5a4a32"
    g.fillRect(0, 0, s, s)
    for (let y = 0; y < s; y += 32) {
      g.fillStyle = y % 64 ? "#634f35" : "#57462f"
      g.fillRect(0, y, s, 30)
    }
    g.strokeStyle = "#3b2f1f"
    g.lineWidth = 18
    g.strokeRect(9, 9, s - 18, s - 18)
    g.beginPath()
    g.moveTo(18, 18)
    g.lineTo(s - 18, s - 18)
    g.stroke()
  })
}

function concreteTexture() {
  return canvasTexture(256, (g, s) => {
    g.fillStyle = "#6b7280"
    g.fillRect(0, 0, s, s)
    for (let i = 0; i < 2500; i++) {
      const v = Math.random() * 40 + 90
      g.fillStyle = `rgba(${v},${v},${v + 8},0.12)`
      g.fillRect(Math.random() * s, Math.random() * s, 3, 3)
    }
    g.fillStyle = "#e0a526"
    for (let x = -s; x < s * 2; x += 48) {
      g.beginPath()
      g.moveTo(x, s - 28)
      g.lineTo(x + 24, s - 28)
      g.lineTo(x + 4, s)
      g.lineTo(x - 20, s)
      g.fill()
    }
    g.fillStyle = "#1f2228"
    g.fillRect(0, s - 30, s, 3)
  })
}

/* ---------- Entities ---------- */

/** Shared soldier model for solo enemies and remote players. Hit meshes carry userData.target/part. */
function buildSoldier(opts: { armor: number; eye: number; gun: boolean; target: object }) {
  const group = new THREE.Group()
  const armor = new THREE.MeshStandardMaterial({ color: opts.armor, roughness: 0.45, metalness: 0.6 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.7, metalness: 0.4 })
  const eye = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: opts.eye, emissiveIntensity: 3 })

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.32, 1.25, 10), armor)
  body.position.y = 0.95
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), dark)
  head.position.y = 1.85
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.12), eye)
  visor.position.set(0, 1.88, 0.24)
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.4, 8), dark)
  legs.position.y = 0.2
  const shoulder = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.22, 0.4), armor)
  shoulder.position.y = 1.5
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), dark)
  gun.position.set(0.42, 1.15, 0.35)
  gun.visible = opts.gun

  for (const m of [body, head, legs, shoulder, gun, visor]) {
    m.castShadow = true
    group.add(m)
  }
  for (const [m, part] of [
    [body, "body"],
    [head, "head"],
    [shoulder, "body"],
    [legs, "body"],
  ] as const) {
    m.userData = { target: opts.target, part }
  }
  const hitMeshes = [body, head, shoulder, legs]
  return { group, hitMeshes, materials: [armor, dark, eye] }
}

class Enemy {
  group: THREE.Group
  hitMeshes: THREE.Mesh[]
  materials: THREE.MeshStandardMaterial[]
  hp: number
  cooldown = 1 + Math.random() * 1.5
  flash = 0
  dead = false
  deathT = 0
  strafe = Math.random() < 0.5 ? -1 : 1
  stuckT = 0
  bobPhase = Math.random() * 10

  constructor(
    public kind: EnemyKind,
    pos: THREE.Vector3
  ) {
    const cfg = ENEMY[kind]
    this.hp = cfg.hp
    const soldier = buildSoldier({
      armor: kind === "grunt" ? 0x7a1f2b : 0xc2561a,
      eye: kind === "grunt" ? 0xff2244 : 0xffaa00,
      gun: kind === "grunt",
      target: this,
    })
    this.group = soldier.group
    this.hitMeshes = soldier.hitMeshes
    this.materials = soldier.materials.slice(0, 2)
    this.group.scale.setScalar(cfg.scale)
    this.group.position.copy(pos)
  }

  get headWorld() {
    return new THREE.Vector3(0, 1.85 * ENEMY[this.kind].scale, 0).add(this.group.position)
  }
}

type Snapshot = { at: number; p: Vec3; yaw: number; pitch: number; alive: boolean }

function nameTag(text: string, color: number) {
  const c = document.createElement("canvas")
  c.width = 256
  c.height = 64
  const g = c.getContext("2d")!
  g.font = "bold 30px ui-monospace, monospace"
  g.textAlign = "center"
  g.textBaseline = "middle"
  const w = Math.min(248, g.measureText(text).width + 28)
  g.fillStyle = "rgba(0,0,0,0.55)"
  g.beginPath()
  g.roundRect(128 - w / 2, 10, w, 44, 12)
  g.fill()
  g.fillStyle = "#" + color.toString(16).padStart(6, "0")
  g.fillRect(128 - w / 2 + 10, 26, 6, 12)
  g.fillStyle = "#fff"
  g.fillText(text, 134, 33)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }))
  sprite.scale.set(1.6, 0.4, 1)
  sprite.position.y = 2.5
  return sprite
}

/** Another player, drawn ~100ms in the past so movement interpolates smoothly between snapshots. */
class RemotePlayer {
  group: THREE.Group
  hitMeshes: THREE.Mesh[]
  materials: THREE.MeshStandardMaterial[]
  tag: THREE.Sprite
  buffer: Snapshot[] = []
  alive = true
  deathT = 0
  flash = 0
  yaw = 0

  constructor(
    public id: string,
    public name: string,
    public color: number
  ) {
    const soldier = buildSoldier({ armor: color, eye: 0x9ff3ff, gun: true, target: this })
    this.group = soldier.group
    this.hitMeshes = soldier.hitMeshes
    this.materials = soldier.materials
    this.tag = nameTag(name, color)
    this.group.add(this.tag)
  }

  get headWorld() {
    return new THREE.Vector3(0, 1.85, 0).add(this.group.position)
  }

  push(s: Snapshot) {
    this.buffer.push(s)
    if (this.buffer.length > 30) this.buffer.shift()
  }

  /** Returns true if a snapshot was available. */
  sample(renderAt: number) {
    const b = this.buffer
    if (!b.length) return false
    let i = b.length - 1
    while (i > 0 && b[i - 1].at > renderAt) i--
    const a = b[Math.max(0, i - 1)]
    const c = b[i]
    const span = c.at - a.at
    const k = span > 0 ? Math.max(0, Math.min(1, (renderAt - a.at) / span)) : 1
    // Teleport on respawn instead of sliding across the map
    const far = Math.hypot(c.p[0] - a.p[0], c.p[2] - a.p[2]) > 4
    const t = far ? 1 : k
    this.group.position.set(a.p[0] + (c.p[0] - a.p[0]) * t, a.p[1] + (c.p[1] - a.p[1]) * t, a.p[2] + (c.p[2] - a.p[2]) * t)
    let dy = c.yaw - a.yaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.yaw = a.yaw + dy * t
    this.group.rotation.y = this.yaw + Math.PI // model faces +z, camera yaw 0 faces -z
    this.alive = c.alive
    return true
  }
}

type Projectile = { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }
type Particle = { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; max: number }
type Tracer = { line: THREE.Line; life: number }
type Pickup = { mesh: THREE.Group; amount: number; t: number }

/* ---------- Game ---------- */

export class FPSGame {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private raf = 0
  private sfx = new Sfx()
  private ro: ResizeObserver
  private disposed = false

  // world
  private boxes: Box[] = []
  private solids: THREE.Mesh[] = []
  private enemies: Enemy[] = []
  private projectiles: Projectile[] = []
  private particles: Particle[] = []
  private tracers: Tracer[] = []
  private pickups: Pickup[] = []

  // player
  private pos = new THREE.Vector3(0, 0, 8)
  private velY = 0
  private grounded = true
  private yaw = 0
  private pitch = 0
  private health = MAX_HEALTH
  private keys = new Set<string>()
  private firing = false
  private fireCd = 0
  private ammo = MAG
  private reloadT = 0
  private kick = 0
  private bob = 0
  private shake = 0
  private hurtCd = 0

  // weapon
  private weapon = new THREE.Group()
  private flash: THREE.Mesh
  private flashLight: THREE.PointLight
  private flashT = 0

  // online
  private mode: "idle" | "solo" | "online" = "idle"
  private net: NetClient | null = null
  private unsubscribe: (() => void) | null = null
  private remotes = new Map<string, RemotePlayer>()
  private dead = false
  private deathT = 0
  private sendT = 0
  private joined = false

  // flow
  private locked = false
  private started = false
  private over = false
  private wave = 0
  private spawnQueue: EnemyKind[] = []
  private spawnT = 0
  private nextWaveT = 0
  private score = 0
  private kills = 0
  private lastHud = ""

  private raycaster = new THREE.Raycaster()
  private projGeo = new THREE.SphereGeometry(0.12, 8, 6)
  private projMat = new THREE.MeshBasicMaterial({ color: 0xff3355 })
  private sparkGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06)

  constructor(
    private container: HTMLElement,
    private events: GameEvents
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)
    // Always fill the container: on HiDPI screens the drawing buffer is larger than the CSS box
    Object.assign(this.renderer.domElement.style, { display: "block", width: "100%", height: "100%" })

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200)
    this.camera.rotation.order = "YXZ"
    this.scene.add(this.camera)

    this.buildWorld()
    const { flash, light } = this.buildWeapon()
    this.flash = flash
    this.flashLight = light

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()

    document.addEventListener("pointerlockchange", this.onLockChange)
    document.addEventListener("mousemove", this.onMouseMove)
    document.addEventListener("mousedown", this.onMouseDown)
    document.addEventListener("mouseup", this.onMouseUp)
    document.addEventListener("keydown", this.onKeyDown)
    document.addEventListener("keyup", this.onKeyUp)
    window.addEventListener("blur", this.onBlur)

    this.syncCamera()
    this.loop()
  }

  /* ----- Public API ----- */

  /** Start (or restart) solo survival. Call from a click so pointer lock and audio are allowed. */
  startSolo() {
    this.sfx.unlock()
    if (this.mode !== "solo" || this.over) this.reset()
    this.mode = "solo"
    if (!this.started) {
      this.started = true
      this.nextWaveT = 1
    }
    this.lock()
  }

  /** Enter an online match. The server's welcome message places the player. Call from a click. */
  startOnline(net: NetClient) {
    this.sfx.unlock()
    this.reset()
    this.mode = "online"
    this.started = true
    this.net = net
    this.unsubscribe = net.on(this.onNet)
    this.lock()
  }

  leaveOnline() {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.net = null
    for (const r of this.remotes.values()) this.removeRemote(r)
    this.reset()
    this.mode = "idle"
    this.started = false
    if (document.pointerLockElement) document.exitPointerLock()
  }

  /** Resume after pausing. Call from a click. */
  resume() {
    this.sfx.unlock()
    this.lock()
  }

  private lock() {
    const req = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
    // Browsers refuse re-locking right after Esc; the menu stays up and the player can click again
    req?.catch?.(() => {})
  }

  dispose() {
    this.unsubscribe?.()
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    document.removeEventListener("pointerlockchange", this.onLockChange)
    document.removeEventListener("mousemove", this.onMouseMove)
    document.removeEventListener("mousedown", this.onMouseDown)
    document.removeEventListener("mouseup", this.onMouseUp)
    document.removeEventListener("keydown", this.onKeyDown)
    document.removeEventListener("keyup", this.onKeyUp)
    window.removeEventListener("blur", this.onBlur)
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((m: THREE.Material & { map?: THREE.Texture | null }) => {
          m.map?.dispose()
          m.dispose()
        })
      }
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.sfx.dispose()
  }

  /* ----- World ----- */

  private buildWorld() {
    const sky = new THREE.Color(0x3a4a66)
    this.scene.background = sky
    this.scene.fog = new THREE.Fog(sky, 30, 90)

    this.scene.add(new THREE.HemisphereLight(0xb8c8ff, 0x4a4038, 1.9))
    const sun = new THREE.DirectionalLight(0xffd6a3, 3)
    sun.position.set(20, 30, 10)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const sc = sun.shadow.camera
    sc.left = sc.bottom = -ARENA - 4
    sc.right = sc.top = ARENA + 4
    sc.near = 1
    sc.far = 90
    sun.shadow.bias = -0.0005
    this.scene.add(sun)

    const ft = floorTexture()
    ft.repeat.set(ARENA, ARENA)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA * 2 + 20, ARENA * 2 + 20),
      new THREE.MeshStandardMaterial({ map: ft, roughness: 0.9, metalness: 0.1 })
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    this.solids.push(floor)

    const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.8 })
    const concrete = concreteTexture()
    const wallMat = new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.95 })
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x737d8c, roughness: 0.6, metalness: 0.15 })

    const add = (x: number, z: number, w: number, d: number, h: number, mat: THREE.Material) => {
      const geo = new THREE.BoxGeometry(w, h, d)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, h / 2, z)
      m.castShadow = m.receiveShadow = true
      this.scene.add(m)
      this.solids.push(m)
      this.boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h })
    }

    const mats = { wall: wallMat, pillar: pillarMat, crate: crateMat }
    for (const box of BOXES) add(box.x, box.z, box.w, box.d, box.h, mats[box.kind])
  }

  private buildWeapon() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x5a616d, roughness: 0.4, metalness: 0.55 })
    const grip = new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.8 })
    const accent = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x2ad4ff, emissiveIntensity: 2 })

    const parts: [THREE.BufferGeometry, THREE.Material, [number, number, number]][] = [
      [new THREE.BoxGeometry(0.09, 0.11, 0.55), metal, [0, 0, 0]],
      [new THREE.CylinderGeometry(0.028, 0.028, 0.3, 10).rotateX(Math.PI / 2), metal, [0, 0.015, -0.4]],
      [new THREE.BoxGeometry(0.07, 0.16, 0.08), grip, [0, -0.12, 0.12]],
      [new THREE.BoxGeometry(0.06, 0.14, 0.09), grip, [0, -0.11, -0.08]],
      [new THREE.BoxGeometry(0.04, 0.05, 0.14), metal, [0, 0.08, 0.05]],
      [new THREE.BoxGeometry(0.095, 0.015, 0.3), accent, [0, 0.035, -0.05]],
    ]
    for (const [g, m, p] of parts) {
      const mesh = new THREE.Mesh(g, m)
      mesh.position.set(...p)
      this.weapon.add(mesh)
    }

    const flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.35, 0.35),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(64, (g, s) => {
          const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
          grd.addColorStop(0, "rgba(255,255,230,1)")
          grd.addColorStop(0.3, "rgba(255,200,80,0.9)")
          grd.addColorStop(1, "rgba(255,120,0,0)")
          g.fillStyle = grd
          g.fillRect(0, 0, s, s)
        }),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    flash.position.set(0, 0.015, -0.6)
    flash.visible = false
    this.weapon.add(flash)
    const light = new THREE.PointLight(0xffc070, 0, 8)
    light.position.set(0, 0, -0.7)
    this.weapon.add(light)

    this.weapon.position.set(0.24, -0.22, -0.45)
    this.weapon.scale.setScalar(0.62)
    // Viewmodel fill light so the gun reads even in shadow
    const fill = new THREE.PointLight(0xbfd4ff, 0.5, 1.5)
    fill.position.set(-0.1, 0.25, 0.1)
    this.weapon.add(fill)
    this.camera.add(this.weapon)
    return { flash, light }
  }

  /* ----- Input ----- */

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.renderer.domElement
    if (!this.locked) {
      this.firing = false
      this.keys.clear()
    }
    this.events.onLock(this.locked)
  }
  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.yaw -= e.movementX * 0.0022
    this.pitch -= e.movementY * 0.0022
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch))
  }
  private onMouseDown = (e: MouseEvent) => {
    if (this.locked && e.button === 0) this.firing = true
  }
  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.firing = false
  }
  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.locked) return
    this.keys.add(e.code)
    if (e.code === "KeyR") this.startReload()
    if (e.code === "Space") e.preventDefault()
  }
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code)
  private onBlur = () => {
    this.keys.clear()
    this.firing = false
  }

  /* ----- Loop ----- */

  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    if (this.mode === "online") this.updateOnline(dt)
    else if (this.locked && this.started && !this.over) this.update(dt)
    else this.idle(dt)
    this.renderer.render(this.scene, this.camera)
  }

  /** Before the game starts: slow orbit so the menu has a living backdrop. */
  private idle(dt: number) {
    if (this.started) return
    this.yaw += dt * 0.08
    this.syncCamera()
  }

  private update(dt: number) {
    this.updatePlayer(dt)
    this.updateWeapon(dt)
    this.updateWaves(dt)
    this.updateEnemies(dt)
    this.updateProjectiles(dt)
    this.updateEffects(dt)
    this.updatePickups(dt)
    this.syncCamera()
    this.pushHud()
  }

  private syncCamera() {
    const shakeX = (Math.random() - 0.5) * this.shake * 0.08
    const shakeY = (Math.random() - 0.5) * this.shake * 0.08
    this.camera.position.set(this.pos.x, this.pos.y + EYE + Math.sin(this.bob * 2) * 0.035, this.pos.z)
    this.camera.rotation.set(this.pitch + this.kick * 0.04 + shakeY, this.yaw + shakeX, 0)
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.renderer.setSize(w, h)
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
  }

  /* ----- Player ----- */

  private collide(p: THREE.Vector3, r: number, feetY = 0) {
    for (const b of this.boxes) {
      if (feetY >= b.h) continue
      const cx = Math.max(b.minX, Math.min(p.x, b.maxX))
      const cz = Math.max(b.minZ, Math.min(p.z, b.maxZ))
      const dx = p.x - cx
      const dz = p.z - cz
      const d2 = dx * dx + dz * dz
      if (d2 >= r * r) continue
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2)
        p.x += (dx / d) * (r - d)
        p.z += (dz / d) * (r - d)
      } else {
        // Centre inside the box: leave by the nearest face
        const pushes = [b.minX - r - p.x, b.maxX + r - p.x, b.minZ - r - p.z, b.maxZ + r - p.z]
        const i = pushes.reduce((best, v, k) => (Math.abs(v) < Math.abs(pushes[best]) ? k : best), 0)
        if (i < 2) p.x += pushes[i]
        else p.z += pushes[i]
      }
    }
    p.x = Math.max(-ARENA + r, Math.min(ARENA - r, p.x))
    p.z = Math.max(-ARENA + r, Math.min(ARENA - r, p.z))
  }

  /** Highest box top under a point (so crates can be stood on). */
  private groundAt(x: number, z: number, r: number, feetY: number) {
    let g = 0
    for (const b of this.boxes) {
      if (b.h > feetY + 0.05) continue
      if (x + r * 0.6 > b.minX && x - r * 0.6 < b.maxX && z + r * 0.6 > b.minZ && z - r * 0.6 < b.maxZ) g = Math.max(g, b.h)
    }
    return g
  }

  private updatePlayer(dt: number) {
    const k = this.dead ? new Set<string>() : this.keys
    const f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0)
    const s = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0)
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight")
    const speed = sprint && f > 0 ? SPRINT : WALK

    const move = new THREE.Vector3()
    if (f || s) {
      const sin = Math.sin(this.yaw)
      const cos = Math.cos(this.yaw)
      move.set(-sin * f + cos * s, 0, -cos * f - sin * s).normalize().multiplyScalar(speed * dt)
      if (this.grounded) this.bob += dt * speed * 1.1
    }
    this.pos.add(move)
    this.collide(this.pos, PLAYER_R, this.pos.y)

    if (k.has("Space") && this.grounded) {
      this.velY = JUMP_V
      this.grounded = false
    }
    this.velY -= GRAVITY * dt
    this.pos.y += this.velY * dt
    const ground = this.groundAt(this.pos.x, this.pos.z, PLAYER_R, this.pos.y)
    if (this.pos.y <= ground) {
      this.pos.y = ground
      this.velY = 0
      this.grounded = true
    } else {
      this.grounded = false
    }

    this.hurtCd = Math.max(0, this.hurtCd - dt)
    this.shake = Math.max(0, this.shake - dt * 3)
  }

  private damage(amount: number, from: THREE.Vector3) {
    if (this.over) return
    this.health = Math.max(0, this.health - amount)
    this.hurtFeedback(from)
    if (this.health <= 0) this.gameOver()
  }

  private hurtFeedback(from: THREE.Vector3) {
    this.shake = Math.min(1, this.shake + 0.6)
    this.sfx.hurt()
    const toward = Math.atan2(from.x - this.pos.x, from.z - this.pos.z)
    const facing = Math.atan2(-Math.sin(this.yaw), -Math.cos(this.yaw))
    let a = toward - facing
    a = Math.atan2(Math.sin(a), Math.cos(a))
    this.events.onDamage(-a)
  }

  /* ----- Weapon ----- */

  private startReload() {
    if (this.reloadT > 0 || this.ammo === MAG || this.over) return
    this.reloadT = RELOAD_TIME
    this.sfx.reload()
  }

  private updateWeapon(dt: number) {
    this.fireCd -= dt
    if (this.reloadT > 0) {
      this.reloadT -= dt
      if (this.reloadT <= 0) {
        this.reloadT = 0
        this.ammo = MAG
      }
    }
    if (this.firing && this.fireCd <= 0 && this.reloadT === 0) {
      if (this.ammo > 0) this.fire()
      else {
        this.sfx.empty()
        this.fireCd = 0.3
        this.startReload()
      }
    }

    this.kick = Math.max(0, this.kick - dt * 9)
    this.flashT -= dt
    this.flash.visible = this.flashT > 0
    this.flashLight.intensity = this.flashT > 0 ? 6 : 0

    // Sway, bob, recoil and the reload dip
    const reloadDip = this.reloadT > 0 ? Math.sin((1 - this.reloadT / RELOAD_TIME) * Math.PI) : 0
    this.weapon.position.set(
      0.2 + Math.cos(this.bob) * 0.01,
      -0.19 + Math.abs(Math.sin(this.bob)) * 0.01 - reloadDip * 0.14,
      -0.38 + this.kick * 0.05
    )
    this.weapon.rotation.set(this.kick * 0.12 + reloadDip * 0.6, 0, reloadDip * 0.4)
  }

  private fire() {
    this.ammo--
    this.fireCd = FIRE_INTERVAL
    this.kick = 1
    this.flashT = 0.05
    this.flash.rotation.z = Math.random() * Math.PI
    this.sfx.shoot()
    this.pitch = Math.min(1.5, this.pitch + 0.012)

    const spread = this.grounded ? 0.006 : 0.03
    const dir = new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, -1)
      .normalize()
      .applyQuaternion(this.camera.quaternion)
    this.raycaster.set(this.camera.position, dir)
    this.raycaster.far = 150
    const living =
      this.mode === "online"
        ? [...this.remotes.values()].filter((r) => r.alive).flatMap((r) => r.hitMeshes)
        : this.enemies.filter((e) => !e.dead).flatMap((e) => e.hitMeshes)
    const hit = this.raycaster.intersectObjects([...this.solids, ...living], false)[0]

    this.weapon.updateWorldMatrix(true, false)
    const muzzle = new THREE.Vector3(0, 0.015, -0.6).applyMatrix4(this.weapon.matrixWorld)
    const end = hit ? hit.point : this.camera.position.clone().addScaledVector(dir, 150)
    this.addTracer(muzzle, end)

    const target = hit?.object.userData.target as Enemy | RemotePlayer | undefined
    if (this.mode === "online") {
      // Server decides damage; hit markers wait for its confirmation
      const o = this.camera.position
      this.net?.send({
        t: "shot",
        o: [o.x, o.y, o.z],
        e: [end.x, end.y, end.z],
        hit: target instanceof RemotePlayer ? { id: target.id, part: hit!.object.userData.part } : null,
      })
      if (hit) this.sparks(hit.point, target ? 0xff3344 : 0xffd27a, target ? 8 : 6)
      return
    }

    if (!hit) return
    const enemy = target instanceof Enemy ? target : undefined
    if (enemy) {
      const headshot = hit.object.userData.part === "head"
      enemy.hp -= headshot ? 3 : 1
      enemy.flash = 0.08
      this.sparks(hit.point, 0xff3344, 8)
      const kill = enemy.hp <= 0
      if (kill) this.killEnemy(enemy, headshot)
      else if (headshot) this.sfx.headshot()
      else this.sfx.hit()
      this.events.onHit(headshot, kill)
    } else {
      this.sparks(hit.point, 0xffd27a, 6)
    }
  }

  private killEnemy(e: Enemy, headshot: boolean) {
    e.dead = true
    this.kills++
    this.score += ENEMY[e.kind].score + (headshot ? 50 : 0)
    this.sfx.kill()
    this.sparks(e.headWorld, 0xff5566, 18)
  }

  /* ----- Enemies ----- */

  private updateWaves(dt: number) {
    if (this.nextWaveT > 0) {
      this.nextWaveT -= dt
      if (this.nextWaveT <= 0) this.startWave()
      return
    }
    if (this.spawnQueue.length) {
      this.spawnT -= dt
      if (this.spawnT <= 0) {
        this.spawnEnemy(this.spawnQueue.shift()!)
        this.spawnT = Math.max(0.35, 1.1 - this.wave * 0.08)
      }
    } else if (this.wave > 0 && this.enemies.every((e) => e.dead)) {
      this.score += 250 * this.wave
      this.spawnPickup()
      this.nextWaveT = 3.5
    }
  }

  private startWave() {
    this.wave++
    const count = 3 + this.wave * 2
    const rushers = this.wave >= 2 ? Math.floor(count * Math.min(0.45, 0.15 + this.wave * 0.05)) : 0
    this.spawnQueue = Array.from({ length: count }, (_, i) => (i < rushers ? "rusher" : "grunt"))
    this.spawnQueue.sort(() => Math.random() - 0.5)
    this.spawnT = 0.4
    this.sfx.wave()
    this.events.onWave(this.wave)
  }

  private spawnEnemy(kind: EnemyKind) {
    const spots = ENEMY_SPAWNS.map(([x, z]) => new THREE.Vector3(x, 0, z))
      .sort((a, b) => b.distanceToSquared(this.pos) - a.distanceToSquared(this.pos))
    const spot = spots[Math.floor(Math.random() * 4)].clone()
    spot.x += (Math.random() - 0.5) * 3
    spot.z += (Math.random() - 0.5) * 3
    const e = new Enemy(kind, spot)
    this.scene.add(e.group)
    this.enemies.push(e)
  }

  private lineOfSight(from: THREE.Vector3, to: THREE.Vector3) {
    const dir = to.clone().sub(from)
    const dist = dir.length()
    this.raycaster.set(from, dir.normalize())
    this.raycaster.far = dist
    return this.raycaster.intersectObjects(this.solids, false).length === 0
  }

  private updateEnemies(dt: number) {
    const playerChest = new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z)

    for (const e of this.enemies) {
      if (e.dead) {
        e.deathT += dt
        e.group.rotation.x = Math.max(-Math.PI / 2, -e.deathT * 5)
        e.group.position.y = -Math.max(0, e.deathT - 0.6) * 1.5
        continue
      }
      const cfg = ENEMY[e.kind]
      const p = e.group.position
      const to = new THREE.Vector3(this.pos.x - p.x, 0, this.pos.z - p.z)
      const dist = to.length()
      to.normalize()

      // Face the player
      e.group.rotation.y = Math.atan2(to.x, to.z)

      // Steering: rushers charge, grunts hold a firing distance and strafe
      const desire = new THREE.Vector3()
      if (e.kind === "rusher") desire.copy(to)
      else if (dist > 13) desire.copy(to)
      else if (dist < 7) desire.copy(to).negate()
      desire.addScaledVector(new THREE.Vector3(to.z, 0, -to.x), e.kind === "grunt" ? e.strafe * 0.6 : 0)
      if (e.stuckT > 0) {
        e.stuckT -= dt
        desire.set(to.z * e.strafe, 0, -to.x * e.strafe)
      }
      // Separation
      for (const o of this.enemies) {
        if (o === e || o.dead) continue
        const d = p.distanceTo(o.group.position)
        if (d < 1.4 && d > 0.001) desire.addScaledVector(p.clone().sub(o.group.position).setY(0).normalize(), 1.2 / d)
      }
      if (desire.lengthSq() > 0) desire.normalize()

      const before = p.clone()
      const step = desire.multiplyScalar(cfg.speed * dt)
      p.add(step)
      this.collide(p, cfg.radius)
      const moved = before.distanceTo(p)
      if (step.length() > 0.001 && moved < step.length() * 0.3 && e.stuckT <= 0) {
        e.stuckT = 0.5 + Math.random() * 0.5
        e.strafe *= -1
      }
      if (Math.random() < dt * 0.3) e.strafe *= -1

      e.bobPhase += dt * cfg.speed * 2
      e.group.position.y = Math.abs(Math.sin(e.bobPhase)) * 0.05

      // Hit flash
      e.flash = Math.max(0, e.flash - dt)
      for (const m of e.materials) m.emissive.setHex(e.flash > 0 ? 0xffffff : 0x000000)

      // Attacks
      e.cooldown -= dt
      if (e.kind === "rusher") {
        if (dist < 1.4 && e.cooldown <= 0 && this.pos.y < 1.2) {
          e.cooldown = 0.8
          this.damage(12, p)
        }
      } else if (e.cooldown <= 0 && dist < 28) {
        const from = e.headWorld
        if (this.lineOfSight(from, playerChest)) {
          e.cooldown = Math.max(0.8, 2.2 - this.wave * 0.1) + Math.random()
          this.enemyShoot(from, playerChest, dist)
        } else {
          e.cooldown = 0.3
        }
      }
    }

    // Clear fallen bodies
    this.enemies = this.enemies.filter((e) => {
      if (e.dead && e.deathT > 1.6) {
        this.scene.remove(e.group)
        e.group.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose())
        e.materials.forEach((m) => m.dispose())
        return false
      }
      return true
    })
  }

  private enemyShoot(from: THREE.Vector3, target: THREE.Vector3, dist: number) {
    const spread = 0.04 + dist * 0.004
    const dir = target
      .clone()
      .sub(from)
      .normalize()
      .add(new THREE.Vector3((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread))
      .normalize()
    const mesh = new THREE.Mesh(this.projGeo, this.projMat)
    mesh.position.copy(from).addScaledVector(dir, 0.6)
    this.scene.add(mesh)
    this.projectiles.push({ mesh, vel: dir.multiplyScalar(20 + this.wave), life: 3 })
    this.sfx.enemyShoot()
  }

  private updateProjectiles(dt: number) {
    const chest = new THREE.Vector3(this.pos.x, this.pos.y + 1.0, this.pos.z)
    this.projectiles = this.projectiles.filter((pr) => {
      const prev = pr.mesh.position.clone()
      pr.mesh.position.addScaledVector(pr.vel, dt)
      pr.life -= dt
      const p = pr.mesh.position
      // Swept test against the player's capsule (approximated by a segment sample)
      const seg = new THREE.Line3(prev, p.clone())
      const closest = new THREE.Vector3()
      seg.closestPointToPoint(chest, true, closest)
      const dy = closest.y - chest.y
      const dxz = Math.hypot(closest.x - chest.x, closest.z - chest.z)
      if (dxz < 0.5 && Math.abs(dy) < 0.9) {
        this.damage(10, prev.clone().sub(pr.vel))
        return this.removeProjectile(pr)
      }
      const blocked = p.y <= 0 || this.boxes.some((b) => p.y < b.h && p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ)
      if (blocked) {
        this.sparks(p, 0xff3355, 5)
        return this.removeProjectile(pr)
      }
      if (pr.life <= 0) return this.removeProjectile(pr)
      return true
    })
  }

  private removeProjectile(pr: Projectile) {
    this.scene.remove(pr.mesh)
    return false
  }

  /* ----- Effects ----- */

  private sparks(at: THREE.Vector3, color: number, n: number) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(this.sparkGeo, new THREE.MeshBasicMaterial({ color, transparent: true }))
      mesh.position.copy(at)
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).multiplyScalar(5)
      const life = 0.3 + Math.random() * 0.3
      this.scene.add(mesh)
      this.particles.push({ mesh, vel, life, max: life })
    }
  }

  private addTracer(from: THREE.Vector3, to: THREE.Vector3) {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to])
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.8 }))
    this.scene.add(line)
    this.tracers.push({ line, life: 0.06 })
  }

  private updateEffects(dt: number) {
    this.particles = this.particles.filter((p) => {
      p.life -= dt
      p.vel.y -= 14 * dt
      p.mesh.position.addScaledVector(p.vel, dt)
      ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, p.life / p.max)
      if (p.life > 0) return true
      this.scene.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
      return false
    })
    this.tracers = this.tracers.filter((t) => {
      t.life -= dt
      if (t.life > 0) return true
      this.scene.remove(t.line)
      t.line.geometry.dispose()
      ;(t.line.material as THREE.Material).dispose()
      return false
    })
  }

  /* ----- Pickups ----- */

  private spawnPickup() {
    const g = new THREE.Group()
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 })
    )
    const crossMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x22ff88, emissiveIntensity: 2 })
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.12), crossMat)
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.52), crossMat)
    a.position.y = b.position.y = 0.26
    g.add(box, a, b)
    g.add(new THREE.PointLight(0x22ff88, 2, 4))
    // Random open spot
    for (let i = 0; i < 30; i++) {
      const p = new THREE.Vector3((Math.random() - 0.5) * (ARENA * 1.6), 0.6, (Math.random() - 0.5) * (ARENA * 1.6))
      const clear = this.boxes.every((bx) => p.x < bx.minX - 1 || p.x > bx.maxX + 1 || p.z < bx.minZ - 1 || p.z > bx.maxZ + 1)
      if (clear) {
        g.position.copy(p)
        break
      }
    }
    this.scene.add(g)
    this.pickups.push({ mesh: g, amount: 35, t: 0 })
  }

  private updatePickups(dt: number) {
    this.pickups = this.pickups.filter((pk) => {
      pk.t += dt
      pk.mesh.rotation.y += dt * 1.5
      pk.mesh.position.y = 0.6 + Math.sin(pk.t * 2.5) * 0.12
      const d = Math.hypot(pk.mesh.position.x - this.pos.x, pk.mesh.position.z - this.pos.z)
      if (d < 1.1 && this.health < MAX_HEALTH) {
        this.health = Math.min(MAX_HEALTH, this.health + pk.amount)
        this.sfx.pickup()
        this.events.onPickup(pk.amount)
        this.scene.remove(pk.mesh)
        return false
      }
      return true
    })
  }

  /* ----- Flow ----- */

  private pushHud() {
    const s: HudState = {
      mode: this.mode === "online" ? "online" : "solo",
      dead: this.dead,
      health: Math.ceil(this.health),
      ammo: this.ammo,
      magSize: MAG,
      reloading: this.reloadT > 0,
      wave: this.wave,
      score: this.score,
      kills: this.kills,
      enemiesLeft: this.spawnQueue.length + this.enemies.filter((e) => !e.dead).length,
    }
    const key = JSON.stringify(s)
    if (key === this.lastHud) return
    this.lastHud = key
    this.events.onHud(s)
  }

  private gameOver() {
    this.over = true
    this.firing = false
    this.pushHud()
    if (document.pointerLockElement) document.exitPointerLock()
    this.events.onGameOver({ score: this.score, wave: this.wave, kills: this.kills })
  }

  private reset() {
    for (const e of this.enemies) this.scene.remove(e.group)
    for (const p of this.projectiles) this.scene.remove(p.mesh)
    for (const p of this.pickups) this.scene.remove(p.mesh)
    this.enemies = []
    this.projectiles = []
    this.pickups = []
    this.pos.set(0, 0, 8)
    this.velY = 0
    this.yaw = 0
    this.pitch = 0
    this.health = MAX_HEALTH
    this.ammo = MAG
    this.reloadT = 0
    this.wave = 0
    this.score = 0
    this.kills = 0
    this.spawnQueue = []
    this.nextWaveT = 1
    this.over = false
    this.dead = false
    this.joined = false
    this.lastHud = ""
  }

  /* ----- Online ----- */

  private onNet = (msg: ServerMsg) => {
    const me = this.net?.id
    switch (msg.t) {
      case "welcome":
        this.joined = true
        this.placeAt(msg.spawn)
        break
      case "roster": {
        const ids = new Set(msg.players.map((p) => p.id))
        for (const r of this.remotes.values()) if (!ids.has(r.id)) this.removeRemote(r)
        for (const p of msg.players) {
          if (p.id === me || this.remotes.has(p.id)) continue
          const r = new RemotePlayer(p.id, p.name, p.color)
          this.remotes.set(p.id, r)
          this.scene.add(r.group)
        }
        break
      }
      case "snap": {
        const at = performance.now()
        for (const st of msg.s) {
          if (st.id === me) {
            this.health = st.hp
            continue
          }
          this.remotes.get(st.id)?.push({ at, p: st.p, yaw: st.yaw, pitch: st.pitch, alive: st.alive })
        }
        break
      }
      case "shot": {
        const r = this.remotes.get(msg.id)
        if (!r) break
        const from = r.headWorld.add(new THREE.Vector3(Math.sin(r.yaw + Math.PI) * 0.5, -0.65, Math.cos(r.yaw + Math.PI) * 0.5))
        this.addTracer(from, new THREE.Vector3(...msg.e))
        const dist = from.distanceTo(this.camera.position)
        this.sfx.shoot(Math.max(0.08, 1 - dist / 45))
        break
      }
      case "hit": {
        if (msg.target === me) {
          this.health = msg.hp
          const r = this.remotes.get(msg.by)
          this.hurtFeedback(r ? r.group.position : this.pos)
        } else {
          const r = this.remotes.get(msg.target)
          if (r) {
            r.flash = 0.08
            this.sparks(msg.part === "head" ? r.headWorld : r.group.position.clone().setY(r.group.position.y + 1), 0xff3344, 6)
          }
          if (msg.by === me && msg.hp > 0) {
            if (msg.part === "head") this.sfx.headshot()
            else this.sfx.hit()
            this.events.onHit(msg.part === "head", false)
          }
        }
        break
      }
      case "kill":
        if (msg.killer === me) {
          this.sfx.kill()
          this.events.onHit(msg.head, true)
        }
        if (msg.victim === me) {
          this.dead = true
          this.deathT = 0
          this.firing = false
          this.health = 0
        }
        break
      case "respawn":
        if (msg.id === me) {
          this.dead = false
          this.health = MAX_HP
          this.ammo = MAG
          this.reloadT = 0
          this.placeAt(msg.p)
        } else {
          // Drop stale history so they don't slide from their death spot
          const r = this.remotes.get(msg.id)
          if (r) r.buffer = []
        }
        break
    }
  }

  private placeAt(p: Vec3) {
    this.pos.set(p[0], p[1], p[2])
    this.velY = 0
    // Face the middle of the arena
    this.yaw = Math.atan2(p[0], p[2])
    this.pitch = 0
  }

  private removeRemote(r: RemotePlayer) {
    this.scene.remove(r.group)
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
    })
    r.materials.forEach((m) => m.dispose())
    r.tag.material.map?.dispose()
    r.tag.material.dispose()
    this.remotes.delete(r.id)
  }

  private updateOnline(dt: number) {
    if (this.joined) {
      if (!this.dead) {
        this.updatePlayer(dt)
        this.updateWeapon(dt)
      } else {
        // Slump to the floor while waiting to respawn
        this.deathT += dt
        this.pitch = Math.max(-0.6, this.pitch - dt * 0.8)
        this.firing = false
      }
      this.sendT -= dt * 1000
      if (this.sendT <= 0 && !this.dead) {
        this.sendT = TICK_MS
        this.net?.send({ t: "state", p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw, pitch: this.pitch })
      }
    }

    const renderAt = performance.now() - 100
    for (const r of this.remotes.values()) {
      const visible = r.sample(renderAt)
      r.group.visible = visible
      if (!r.alive) {
        r.deathT += dt
        r.group.rotation.x = Math.max(-Math.PI / 2, -r.deathT * 5)
        r.tag.visible = false
      } else {
        r.deathT = 0
        r.group.rotation.x = 0
        r.tag.visible = true
      }
      r.flash = Math.max(0, r.flash - dt)
      for (const m of r.materials.slice(0, 2)) m.emissive.setHex(r.flash > 0 ? 0xffffff : 0x000000)
    }

    this.updateEffects(dt)
    this.syncCamera()
    if (this.dead) this.camera.position.y = this.pos.y + Math.max(0.4, EYE - this.deathT * 3)
    this.pushHud()
  }
}
