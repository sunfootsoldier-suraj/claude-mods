// The slayer theme: chibi fan heads of the Demon Slayer cast, for a personal pane.
// One slayer head floats in the yard for the main loop. Inosuke is the default. While work runs, the
// cast rotates each turn and each 30 seconds, and each one shows their own breathing
// technique. A messenger crow flies for each running subagent. Rui appears when a
// call fails. While a workflow runs, small slayers fight demons on the ground and a
// flock of crows crosses the yard. Each turn row gets a portrait: a slayer when the turn worked, ranked by
// how long and how much it ran, and a demon when calls failed, ranked by how many.

import { drawYard as drawCatYard, flip, newPixels, paint, petAlt as catAlt } from './pets'
import type { PetMood, PetScene, Pixels, Rgb, Sprite, Yard } from './pets'

const PAL: Record<string, Rgb> = {
  o: 0x3b3b52, // outline and shoes
  H: 0x2a1f2e, // Tanjiro hair
  r: 0xb33a3a, // Tanjiro scar
  s: 0xf6d5b8, // skin
  e: 0x8b1e2d, // red eye
  h: 0xffffff, // white light
  p: 0xff8fab, // blush
  m: 0x7a3b3b, // mouth
  a: 0x7dcfff, // light water
  Z: 0x3d7cc9, // deep water and blue eyes
  w: 0xf2efe9, // white
  u: 0x23263a, // uniform
  q: 0x111118, // sheath
  y: 0xe0af68, // gold
  l: 0xc8d3e6, // blade
  F: 0xff7a3d, // flame
  Y: 0xffd166, // yellow hair and flame light
  O: 0xf2a33a, // Zenitsu haori orange
  A: 0xffb000, // amber eye
  g: 0x2f8f6a, // Tanjiro haori green
  c: 0x16161c, // Tanjiro haori black
  b: 0x8a7f73, // Inosuke boar mask
  d: 0x5c534a, // boar mask shade
  N: 0xc9a08a, // boar snout
  f: 0x7a5a3a, // fur belt
  j: 0x6f7fa3, // Inosuke trousers
  X: 0x1c1a2a, // black hair
  E: 0xe0703a, // Nezuko hair tips
  M: 0xf78fb3, // pink
  v: 0x8fbf5a, // bamboo
  V: 0x4f6f2a, // bamboo knot
  T: 0x7a4a2a, // Nezuko haori brown
  D: 0xc0392b, // red
  W: 0x7a1f2b, // Giyu haori maroon
  G: 0x4f9f6a, // Giyu haori green
  K: 0x2e3040, // crow
  B: 0x5a6b9a, // crow sheen
  k: 0xd03b3b, // crow eye
  P: 0xe8e0ef, // pale demon skin
  S: 0xd9a88a, // muscle shade
  n: 0xffc8dc, // light pink pattern
  I: 0x3a1a22, // Tanjiro hair, dark wine
  J: 0x7a2a32, // Tanjiro hair light
  C: 0x4a5f88, // Inosuke mask shade, blue grey
  U: 0x9aa6b8, // Inosuke mask fur
}

// ---- the cast ------------------------------------------------------------------------

export type CastName = 'inosuke' | 'tanjiro' | 'zenitsu' | 'nezuko' | 'rengoku' | 'giyu'

// The rotation order. The first is the default.
export const CAST: CastName[] = ['inosuke', 'tanjiro', 'zenitsu', 'nezuko', 'rengoku', 'giyu']

type Member = {
  name: string
  art: string
  // The head: 11 rows, 12 pixels wide, facing front, with a strip of collar at the bottom.
  head: Sprite
  // Rows 5 and 6 hold the eyes. These two rows replace them when the eyes close.
  shut: [string, string]
}

const MEMBERS: Record<CastName, Member> = {
  // A blue-grey boar-head mask: pointed ears, hollow eyes, a pale snout, white tusks.
  inosuke: {
    name: 'Inosuke',
    art: 'Beast Breathing',
    head: [
      'CC........CC',
      'CUCUUUUUUCUC',
      'UUUUUUUUUUUU',
      'UUUCUUUUCUUU',
      'UUUUUUUUUUUU',
      'UooUUUUUUooU',
      'UohUUNNUUhoU',
      'UUUUNNNNUUUU',
      'UwUNoNNoNUwU',
      '.UwNNNNNNwU.',
      '..UssssssU..',
    ],
    shut: ['UooUUUUUUooU', 'UohUUNNUUhoU'],
  },
  // Dark wine hair, the forehead scar, red eyes, hanafuda earrings, the check haori collar.
  tanjiro: {
    name: 'Tanjiro',
    art: 'Water Breathing',
    head: [
      '...IIIIII...',
      '.IIIJIIJIII.',
      'IIIIIIIIIIII',
      'IIIIIIIIIDDI',
      'IIsIsssIsDsI',
      'IshessssehsI',
      'IseesssseesI',
      'wpsssssssspw',
      'DssssmmssssD',
      'w.ssssssss.w',
      '.gcgcuucgcg.',
    ],
    shut: ['IssssssssssI', 'IsoossssoosI'],
  },
  // Spiky gold hair with orange ends, thick brows, amber eyes, orange haori with white triangles.
  zenitsu: {
    name: 'Zenitsu',
    art: 'Thunder Breathing',
    head: [
      '..Y.YYYY.Y..',
      '.YYYYYYYYYY.',
      'YYYYYYYYYYYY',
      'YYYsYYYYsYYY',
      'OYsYYssYYsYO',
      'OshAssssAhsO',
      'OsAAssssAAsO',
      'OpsssssssspO',
      '.ssssmmssss.',
      '..ssssssss..',
      '.OwOwuuwOwO.',
    ],
    shut: ['OssssssssssO', 'OsoossssoosO'],
  },
  // Long black hair with orange ends, the pink ribbon, pink eyes, the bamboo muzzle.
  nezuko: {
    name: 'Nezuko',
    art: 'Blood Demon Art',
    head: [
      '...XXXXX.MM.',
      '.XXXXXXXXMMM',
      'XXXXXXXXXXM.',
      'XXXXXXXXXXXX',
      'XXsXssssXsXX',
      'XshMssssMhsX',
      'XsMMssssMMsX',
      'XpsssssssspX',
      'XVvvvvvvvvVX',
      'XXssssssssXX',
      'E.MMnMMnMM.E',
    ],
    shut: ['XssssssssssX', 'XsoossssoosX'],
  },
  // Gold flame hair with crimson tips, forked brows, gold eyes ringed red, a wide smile.
  rengoku: {
    name: 'Rengoku',
    art: 'Flame Breathing',
    head: [
      'D.YD.YY.DY.D',
      'DYYDYYYYDYYD',
      'YYYYYYYYYYYY',
      'YDYYYYYYYYDY',
      'YYDDssssDDYY',
      'YDAhsssshADY',
      'YsAAssssAAsY',
      'YpsssssssspY',
      '.ssmwwwwmss.',
      '..ssmmmmss..',
      '.wwwuuuuwww.',
    ],
    shut: ['YYssssssssYY', 'YsoossssoosY'],
  },
  // Untidy black hair, calm half-shut blue eyes, the haori half maroon and half pattern.
  giyu: {
    name: 'Giyu',
    art: 'Water Breathing, Dead Calm',
    head: [
      '...XXXXXX...',
      '.XXXXXXXXXX.',
      'XXXXXXXXXXXX',
      'XXXsXXXXsXXX',
      'XXsXsssXssXX',
      'XsXXssssXXsX',
      'XsZhssssZhsX',
      'XssssssssssX',
      'XsssssmssssX',
      'X.ssssssss.X',
      '.WWWuuuGyGO.',
    ],
    shut: ['XsXXssssXXsX', 'XsoossssoosX'],
  },
}

export const castName = (c: CastName): string => MEMBERS[c].name
export const castArt = (c: CastName): string => MEMBERS[c].art

const W = 12
const H = 11
// The slayer yard is 6 terminal rows: 12 pixels.
const YARD_H = 12

export type CastFacts = { pin: CastName | 'rotate'; isBusy: boolean; turn: number; turnStartedAt: number; now: number }

// Who floats in the yard. At rest it is Inosuke. While work runs, the cast rotates
// with each turn and with each 30 seconds of a long turn.
export function castAt(f: CastFacts): CastName {
  if (f.pin !== 'rotate') return f.pin
  if (!f.isBusy || f.turn < 1) return CAST[0]!
  const steps = f.turnStartedAt ? Math.max(0, Math.floor((f.now - f.turnStartedAt) / 30_000)) : 0
  return CAST[(f.turn - 1 + steps) % CAST.length]!
}

// The technique shows while a tool runs, and for a short time each 6 seconds at rest.
function isBreathing(mood: PetMood, tick: number): boolean {
  if (mood === 'run' || mood === 'type' || mood === 'read') return true
  return mood === 'idle' && tick % 40 >= 32
}

// The head and how high it floats. It bobs at rest, hops as it moves, and jumps when done.
function frame(c: CastName, mood: PetMood, tick: number): { sprite: Sprite; lift: number } {
  const m = MEMBERS[c]
  const blink = tick % 27 === 0 || tick % 27 === 1
  const isShut = blink || mood === 'sleep' || mood === 'happy'
  const sprite = m.head.map((r, i) => (isShut && i === 5 ? m.shut[0] : isShut && i === 6 ? m.shut[1] : r))
  let lift = 0
  if (mood === 'walk' || mood === 'run') lift = Math.floor(tick / 2) % 2
  else if (mood === 'happy') lift = tick % 2
  else if (mood === 'idle' || mood === 'think' || mood === 'read') lift = tick % 16 < 8 ? 0 : 1
  return { sprite, lift }
}

function dot(p: Pixels, x: number, y: number, rgb: Rgb): void {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return
  p.px[y * p.w + x] = rgb
}

// ---- breathing techniques: drawn around the head --------------------------------------

// Inosuke: two jagged blades that cross in an X and tear forward like claws.
function beast(p: Pixels, x: number, dir: number, tick: number): void {
  const front = dir > 0 ? x + W : x - 1
  const reach = 4 + (tick % 3) * 2
  for (let i = 0; i < reach; i++) {
    const jag = i % 2
    const tip = i === reach - 1 ? 0xffffff : PAL.l!
    dot(p, front + dir * i, 1 + i + jag, tip)
    dot(p, front + dir * i, 10 - i - jag, tip)
    if (i % 3 === 1) dot(p, front + dir * i, 2 + i + jag, 0x8f9bb3)
  }
}

// Tanjiro: a water wheel. An arc of water turns around the head.
function water(p: Pixels, x: number, _dir: number, tick: number): void {
  const cx = x + W / 2 - 0.5
  const cy = 5.5
  for (let k = 0; k < 22; k++) {
    const t = (tick * 0.45 + (k / 22) * Math.PI * 1.8) % (Math.PI * 2)
    const px = Math.round(cx + 8.5 * Math.cos(t))
    const py = Math.round(cy + 5.5 * Math.sin(t))
    if (px >= x && px < x + W && py >= 0 && py < H) continue
    dot(p, px, py, k > 18 ? 0xffffff : k % 2 ? PAL.a! : PAL.Z!)
  }
}

// Zenitsu: bolts of lightning that strike forward, with a flicker.
function thunder(p: Pixels, x: number, dir: number, tick: number): void {
  if (tick % 3 === 2) return
  const front = dir > 0 ? x + W : x - 1
  for (const base of [2, 8]) {
    let py = base + (tick % 2)
    for (let i = 0; i < 12; i++) {
      py += i % 4 === 1 ? 1 : i % 4 === 3 ? -1 : 0
      dot(p, front + dir * i, py, i % 3 === 0 ? 0xffffff : PAL.Y!)
      if (i % 4 === 2) dot(p, front + dir * i, py + 1, PAL.Y!)
    }
  }
  // A small spark at each side of the head.
  dot(p, x - 2 * dir, 1 + (tick % 4), 0xffffff)
}

// Nezuko: pink demon flames that rise around her.
function blood(p: Pixels, x: number, tick: number): void {
  for (let k = 0; k < 10; k++) {
    const side = k % 2 ? x - 1 - (k % 4) : x + W + (k % 4)
    const fy = YARD_H - 1 - ((tick + k * 3) % 11)
    dot(p, side, fy, k % 3 ? 0xff6fb5 : 0xff9ad5)
    dot(p, side, fy + 1, 0xd94f8a)
  }
}

// Rengoku: an arc of fire in front, and flames that dance on the hair.
function flame(p: Pixels, x: number, dir: number, tick: number): void {
  const cx = dir > 0 ? x + W : x - 1
  const cy = 5
  const sweep = [0.4, 0.7, 1, 1][tick % 4] ?? 1
  for (let k = 0; k <= 12; k++) {
    const t = -1.4 + 2.8 * (k / 12) * sweep
    const px = cx + Math.round(dir * 5 * Math.cos(t))
    const py = cy + Math.round(5 * Math.sin(t))
    dot(p, px, py, k % 3 === 0 ? PAL.Y! : PAL.F!)
    dot(p, px - dir, py, k % 2 ? PAL.F! : PAL.D!)
  }
  for (let k = 0; k < 3; k++) dot(p, x + 2 + k * 4 + (tick % 2), (tick + k) % 3 === 0 ? 0 : 1, k % 2 ? PAL.F! : PAL.Y!)
}

// Giyu: Dead Calm. Still rings of water spread at his sides.
function calm(p: Pixels, x: number, tick: number): void {
  const cx = x + W / 2
  for (const r of [(tick % 6) * 2 + 7, ((tick + 3) % 6) * 2 + 7]) {
    for (let a = 0; a < 28; a++) {
      const t = (a / 28) * Math.PI * 2
      const py = YARD_H - 2 + Math.round(1.5 * Math.sin(t))
      const px = Math.round(cx + r * Math.cos(t))
      if (px >= x && px < x + W) continue
      dot(p, px, py, a % 3 ? PAL.a! : PAL.Z!)
    }
  }
}

function breathe(c: CastName, p: Pixels, x: number, dir: number, tick: number): void {
  if (c === 'inosuke') beast(p, x, dir, tick)
  else if (c === 'tanjiro') water(p, x, dir, tick)
  else if (c === 'zenitsu') thunder(p, x, dir, tick)
  else if (c === 'nezuko') blood(p, x, tick)
  else if (c === 'rengoku') flame(p, x, dir, tick)
  else calm(p, x, tick)
}

// ---- crows and the demon ----------------------------------------------------------------

const CROW_UP: Sprite = ['.BB....', 'KKBKKk.', '.KKKKKy', '..KK...']
const CROW_DOWN: Sprite = ['.......', 'KKBKKk.', '.KKKKKy', '.BK....']

// Rui's head: white hair, pale skin, red eyes, red lines down the face, a white collar.
const RUI: Sprite = [
  '..wwwwww..',
  '.wwwwwwww.',
  'wwwPwwPwww',
  'wPPPPPPPPw',
  'wDDPPPPDDw',
  'wDkPPPPkDw',
  'wDPPmmPPDw',
  '.PPPPPPPP.',
  '..wwDDww..',
]

// ---- the workflow battle ----------------------------------------------------------------

// While a workflow runs, pairs of small slayers and demons fight along the ground,
// one pair for each running workflow agent, as many as the yard holds.
const MINI_SLAYERS: Portrait[] = ['swordsman', 'recruit', 'fighter', 'pillar', 'resting']
const MINI_DEMONS: Portrait[] = ['lesser', 'demon', 'upper']
const MINI_BODY: Record<'slayer' | 'demon' | 'upper', Sprite> = {
  slayer: ['.uuuu.', '.o..o.'],
  demon: ['.PDDP.', '.P..P.'],
  upper: ['.qqqq.', '.q..q.'],
}
// A slayer, a gap for the blade, a demon, and space before the next pair.
const PAIR_W = 16
const PAIR_STEP = 18
const MINI_TOP = YARD_H - 6
// The most crows that fly while a workflow runs.
const SWARM_CROWS = 8

// The places on the ground for the pairs. The slayer head keeps its own place.
export function battleSlots(headX: number, width: number, swarm: number): number[] {
  const out: number[] = []
  for (let sx = 1; sx + PAIR_W <= width && out.length < swarm; sx += PAIR_STEP) {
    if (sx < headX + W + 1 && sx + PAIR_W > headX - 1) continue
    out.push(sx)
  }
  return out
}

function miniFighter(p: Pixels, kind: Portrait, body: Sprite, x: number, top: number, tick: number, isDemon: boolean): void {
  const face = (FACES[kind] ?? FACES.recruit)[Math.floor(tick / 3) % 2]!
  paint(p, isDemon ? flip(face) : face, x, top, undefined, PAL)
  paint(p, body, x, top + 4, undefined, PAL)
}

function drawBattle(p: Pixels, headX: number, width: number, swarm: number, tick: number): void {
  battleSlots(headX, width, swarm).forEach((sx, i) => {
    // Each pair keeps its own beat, so the strikes do not all land at once.
    const beat = (tick + i * 2) % 6
    const isStrike = beat === 3 || beat === 4
    const slayer = MINI_SLAYERS[i % MINI_SLAYERS.length]!
    const demon = MINI_DEMONS[i % MINI_DEMONS.length]!
    const lunge = isStrike ? 1 : 0
    const bob = (tick + i) % 4 < 2 ? 0 : 1
    miniFighter(p, slayer, MINI_BODY.slayer, sx + lunge, MINI_TOP + bob, tick + i, false)
    const dx = sx + 10 + (isStrike ? 1 : 0)
    miniFighter(p, demon, demon === 'upper' ? MINI_BODY.upper : MINI_BODY.demon, dx, MINI_TOP + (1 - bob), tick + i, true)
    // The blade: it rests short and reaches the demon on the strike.
    const reach = isStrike ? 4 : 1 + (beat % 2)
    for (let k = 0; k < reach; k++) dot(p, sx + lunge + 6 + k, MINI_TOP + bob + 4 - Math.min(k, 1), k === reach - 1 ? 0xffffff : PAL.l!)
    if (isStrike) {
      // A spark where the blade lands, and the demon's claw strikes back.
      const hx = sx + lunge + 6 + reach
      dot(p, hx, MINI_TOP + 2, 0xffffff)
      dot(p, hx - 1, MINI_TOP + 1, PAL.Y!)
      dot(p, hx - 1, MINI_TOP + 3, PAL.Y!)
      if (beat === 4) dot(p, dx - 1, MINI_TOP + 5, PAL.D!)
    }
  })
}

function drawSlayerYard(y: Yard, scene: PetScene, width: number): Pixels {
  const p = newPixels(width, YARD_H)
  const c = scene.who ?? CAST[0]!
  const { sprite, lift } = frame(c, scene.mood, y.tick)
  const isMoving = scene.mood === 'walk' || scene.mood === 'run'
  const dir = isMoving ? y.dir : 1
  const top = YARD_H - H - lift
  const isArt = isBreathing(scene.mood, y.tick)
  // Water and blood go behind the head, so they are drawn first.
  const isBehind = c === 'tanjiro' || c === 'giyu' || c === 'nezuko'
  if (isArt && isBehind) breathe(c, p, y.x, dir, y.tick)
  if (scene.swarm) drawBattle(p, y.x, width, scene.swarm, y.tick)
  paint(p, dir < 0 ? flip(sprite) : sprite, y.x, top, undefined, PAL)
  if (isArt && !isBehind) breathe(c, p, y.x, dir, y.tick)
  // Sparkles burst around the head when the turn is done.
  if (scene.mood === 'happy') {
    const r = 7 + (y.tick % 3)
    for (let k = 0; k < 8; k++) {
      const t = (k / 8) * Math.PI * 2 + y.tick * 0.3
      dot(p, Math.round(y.x + 5.5 + r * Math.cos(t)), Math.round(5.5 + 0.7 * r * Math.sin(t)), k % 2 ? 0xffd166 : 0xffffff)
    }
  }
  // A failed call brings Rui. Rui floats in front of the slayer and shakes.
  if (scene.mood === 'sad') {
    const ox = Math.min(width - RUI[0]!.length, y.x + W + 3) + (y.tick % 2)
    paint(p, RUI, ox, YARD_H - RUI.length - (y.tick % 4 < 2 ? 0 : 1), undefined, PAL)
    // A sweat drop on the slayer.
    dot(p, y.x + W - 1, top + 3 + (y.tick % 3), PAL.a!)
  }
  // Messenger crows fly at the top for the running subagents, each a little out of step.
  if (scene.swarm) {
    // A flock crosses the whole yard while a workflow runs.
    const n = Math.min(scene.slimes.length, SWARM_CROWS)
    const span = width + 8
    for (let i = 0; i < n; i++) {
      const s = (y.tick + i * 2) % 4 < 2 ? CROW_UP : CROW_DOWN
      const cx = ((y.tick + Math.floor((i * span) / n)) % span) - 7
      paint(p, s, cx, (y.tick + i * 3) % 6 < 3 ? i % 2 : 1 - (i % 2), undefined, PAL)
    }
  } else scene.slimes.slice(0, 5).forEach((_, i) => {
    const wing = (y.tick + i * 2) % 4 < 2
    const s = wing ? CROW_UP : CROW_DOWN
    const behind = y.x - 9 * (i + 1)
    const cx = behind >= 0 ? behind : y.x + W + 2 + 9 * i
    const cy = (y.tick + i * 3) % 6 < 3 ? 0 : 1
    paint(p, cx < y.x ? s : flip(s), cx, cy, undefined, PAL)
  })
  const headCol = y.x + W
  if (scene.mood === 'sleep') {
    const t = y.tick % 12
    if (t >= 2) p.marks.push({ col: headCol, row: 2, ch: 'z', rgb: 0x7aa2f7 })
    if (t >= 6) p.marks.push({ col: headCol + 1, row: 1, ch: 'z', rgb: 0x7aa2f7 })
    if (t >= 9) p.marks.push({ col: headCol + 2, row: 0, ch: 'Z', rgb: 0x7aa2f7 })
  } else if (scene.mood === 'think') {
    p.marks.push({ col: headCol, row: 1, ch: y.tick % 6 < 3 ? '?' : '·', rgb: 0xe0af68 })
  }
  return p
}

export function drawScene(y: Yard, scene: PetScene, width: number): Pixels {
  return scene.theme === 'slayer' ? drawSlayerYard(y, scene, width) : drawCatYard(y, scene, width)
}

// The words beside the yard: who stands there, and the technique while it shows.
export function sceneTag(y: Yard, scene: PetScene): string {
  if (scene.theme !== 'slayer') return ''
  const c = scene.who ?? CAST[0]!
  const tag = isBreathing(scene.mood, y.tick) ? `${castName(c)} · ${castArt(c)}` : castName(c)
  return scene.swarm ? `${tag} · workflow battle: ${scene.swarm} agent${scene.swarm === 1 ? '' : 's'}` : tag
}

export function sceneAlt(scene: PetScene): string {
  if (scene.theme !== 'slayer') return catAlt(scene)
  const who = castName(scene.who ?? CAST[0]!)
  const art = castArt(scene.who ?? CAST[0]!)
  const what: Record<PetMood, string> = {
    idle: `${who} floats and waits.`,
    sleep: `${who} sleeps.`,
    think: `${who} thinks.`,
    walk: `${who} hops along.`,
    run: `${who} runs a command: ${art}.`,
    type: `${who} makes an edit: ${art}.`,
    read: `${who} reads: ${art}.`,
    happy: `${who} jumps: the turn is done.`,
    sad: 'Rui appears: a call failed.',
  }
  const n = scene.slimes.length
  const crows = n ? ` ${n} crow${n === 1 ? '' : 's'} fly above for the subagents.` : ''
  const w = scene.swarm ?? 0
  const battle = w ? ` A workflow runs: slayers fight demons on the ground for its ${w} agent${w === 1 ? '' : 's'}.` : ''
  return `${what[scene.mood]}${crows}${battle}`
}

// ---- turn portraits ------------------------------------------------------------------

export type Portrait = 'recruit' | 'swordsman' | 'pillar' | 'fighter' | 'resting' | 'crow' | 'lesser' | 'demon' | 'upper'

// 6 by 4 pixels: two terminal rows, beside the prompt line and the summary line.
const FACES: Record<Portrait, [Sprite, Sprite]> = {
  // Zenitsu: gold hair, amber eyes, orange and white haori
  recruit: [
    ['YYOYYO', 'OAssAO', '.smms.', 'OwOwOw'],
    ['YYOYYO', 'OossoO', '.smms.', 'wOwOwO'],
  ],
  // Tanjiro: scar, earrings, check haori
  swordsman: [
    ['IIIIDI', 'wesseW', 'DsmssD', 'gcgcgc'],
    ['IIIIDI', 'wossoW', 'DsmssD', 'cgcgcg'],
  ],
  // Rengoku: flame hair, gold eyes, flame hem
  pillar: [
    ['DYYDYD', 'YAssAY', '.smms.', 'FwuuwF'],
    ['YDYYDY', 'YAssAY', '.smms.', 'wFuuFw'],
  ],
  // Inosuke: boar mask, tusks, fur pelt
  fighter: [
    ['CUUUUC', 'UoUUoU', 'UwNNwU', 'ssffss'],
    ['CUUUUC', 'UoUUoU', 'UwNNwl', 'ssffsl'],
  ],
  // Nezuko asleep: pink ribbon, bamboo muzzle
  resting: [
    ['XXXXMM', 'XossoX', 'XvvvvX', 'ETMMTE'],
    ['XXXXMM', 'XossoX', 'XvvvvX', 'ETMMTE'],
  ],
  crow: [
    ['..BK..', 'KBKKk.', '.KKKKy', '..y.y.'],
    ['.BB...', '.KBKk.', 'KKKKKy', '..y.y.'],
  ],
  // Rui: white hair, red eyes and face lines
  lesser: [
    ['wwwwww', 'wDPPDw', 'PDmmDP', 'wwDwww'],
    ['wwwwww', 'wkPPkw', 'PDmmDP', 'wwwDww'],
  ],
  // Akaza: pink hair, gold eyes, blue lines
  demon: [
    ['MMMMMM', 'MAPPAM', 'ZPZZPZ', '.MuuM.'],
    ['MMMMMM', 'MYPPYM', 'ZPZZPZ', '.MuuM.'],
  ],
  // Muzan: white hat, red eyes, black suit
  upper: [
    ['.wqqw.', 'wwwwww', 'XDPPDX', 'qPmmPq'],
    ['.wqqw.', 'wwwwww', 'XkPPkX', 'qPmmPq'],
  ],
}

export const PORTRAIT_W = 6
export const PORTRAIT_H = 4

export const PORTRAIT_NAMES: Record<Portrait, string> = {
  recruit: 'Zenitsu: a quick turn that worked',
  swordsman: 'Tanjiro: a longer turn that worked',
  pillar: 'Rengoku, a Hashira: a long, hard turn that worked',
  fighter: 'Inosuke in a fight: the turn runs now',
  resting: 'Nezuko asleep: you stopped the turn',
  crow: 'crow: a background update',
  lesser: 'Rui: one call failed',
  demon: 'Akaza: several calls failed',
  upper: 'Muzan: many calls failed, or the turn ended on an error',
}

export type TurnFacts = { isRunning: boolean; isAuto: boolean; isStopped: boolean; isErrorEnd: boolean; calls: number; failed: number; ms: number }

// The rules that pick a portrait. Failures pick a demon by count. A turn that
// worked picks a rank by its time and its calls.
export function portraitFor(f: TurnFacts): Portrait {
  if (f.isRunning) return 'fighter'
  if (f.isErrorEnd || f.failed >= 5) return 'upper'
  if (f.failed >= 2 && f.failed / Math.max(1, f.calls) >= 0.1) return 'demon'
  if (f.failed >= 1 && f.failed / Math.max(1, f.calls) >= 0.1) return 'lesser'
  if (f.isStopped) return 'resting'
  if (f.isAuto) return 'crow'
  if (f.ms >= 300_000 || f.calls >= 30) return 'pillar'
  if (f.ms >= 60_000 || f.calls >= 6) return 'swordsman'
  return 'recruit'
}

export function portraitPixels(kind: Portrait, frame: number): Pixels {
  const p = newPixels(PORTRAIT_W, PORTRAIT_H)
  const pair = FACES[kind] ?? FACES.recruit
  paint(p, pair[frame % 2]!, 0, 0, undefined, PAL)
  return p
}
