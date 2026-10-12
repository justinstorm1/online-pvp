/** Arena layout shared by the client (rendering, collision) and the server (spawns). */

export const ARENA = 30 // half-size of the square arena

export type ArenaBox = {
  x: number
  z: number
  w: number
  d: number
  h: number
  kind: "wall" | "pillar" | "crate"
}

const T = 1 // perimeter wall thickness

export const BOXES: ArenaBox[] = [
  // Perimeter
  { x: 0, z: -ARENA - T / 2, w: ARENA * 2 + T * 2, d: T, h: 5, kind: "wall" },
  { x: 0, z: ARENA + T / 2, w: ARENA * 2 + T * 2, d: T, h: 5, kind: "wall" },
  { x: -ARENA - T / 2, z: 0, w: T, d: ARENA * 2, h: 5, kind: "wall" },
  { x: ARENA + T / 2, z: 0, w: T, d: ARENA * 2, h: 5, kind: "wall" },
  // Cover walls
  ...(
    [
      [-12, -6, 8, 0.6],
      [12, 6, 8, 0.6],
      [0, -16, 0.6, 8],
      [0, 16, 0.6, 8],
      [-20, 14, 0.6, 7],
      [20, -14, 0.6, 7],
    ] as const
  ).map(([x, z, w, d]) => ({ x, z, w, d, h: 2.2, kind: "wall" as const })),
  // Pillars
  ...(
    [
      [-6, -6],
      [6, -6],
      [-6, 6],
      [6, 6],
      [-18, -20],
      [18, 20],
    ] as const
  ).map(([x, z]) => ({ x, z, w: 1.4, d: 1.4, h: 6, kind: "pillar" as const })),
  // Crates
  ...(
    [
      [-3, -12, 1.6],
      [-1.4, -12.4, 1.2],
      [10, -10, 2],
      [-10, 10, 2],
      [22, 2, 1.6],
      [-22, -2, 1.6],
      [-24, 22, 2],
      [24, -22, 2],
      [14, 18, 1.4],
      [-14, -18, 1.4],
      [3, 22, 1.6],
      [-3, -24, 1.6],
    ] as const
  ).map(([x, z, s]) => ({ x, z, w: s, d: s, h: s, kind: "crate" as const })),
]

/** Where solo-mode enemies enter. */
export const ENEMY_SPAWNS: [number, number][] = [
  [-26, -26],
  [26, -26],
  [-26, 26],
  [26, 26],
  [0, -27],
  [0, 27],
  [-27, 0],
  [27, 0],
]

/** Open spots for PvP (re)spawns, spread around the map. */
export const PLAYER_SPAWNS: [number, number][] = [
  [-26, -12],
  [26, 12],
  [-12, 26],
  [12, -26],
  [-14, 14],
  [14, -14],
  [-26, 4],
  [26, -4],
  [-8, -26],
  [8, 26],
  [0, 0],
]
