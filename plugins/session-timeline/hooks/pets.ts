// Chibi pixel pets for the timeline pane. A cat stands for the main loop, and one
// slime stands for each running subagent. Each terminal cell holds two pixels: the
// upper half block takes the top pixel as its foreground and the bottom as its
// background. Remote surfaces get the same pixels as an SVG.

import type { CastName } from './slayer'

export type PetMood = 'idle' | 'sleep' | 'think' | 'walk' | 'run' | 'type' | 'read' | 'happy' | 'sad'

export type PetTheme = 'cat' | 'slayer'

export type PetScene = {
  theme: PetTheme
  mood: PetMood
  // One entry per running subagent, by type, oldest first.
  slimes: string[]
  // The slayer in the yard. The cat theme ignores it.
  who?: CastName
  // The running agents that a workflow started. The slayer theme draws a battle for them.
  swarm?: number
}

export type Rgb = number
export const NONE = -1
const DEFAULT = 0x01000000

const PALETTE: Record<string, Rgb> = {
  o: 0x3b3b52, // outline
  c: 0xf5a25d, // fur
  w: 0xfff4e6, // belly
  e: 0x1a1a2e, // eye
  h: 0xffffff, // eye light
  p: 0xff8fab, // blush
  m: 0x5a3a3a, // mouth
  b: 0x7dcfff, // tear
  k: 0x9aa5ce, // laptop
  K: 0x565f89, // laptop edge
  g: 0x73c991, // screen glow
  n: 0xe0af68, // book
}

const SLIME_TINT: Record<string, Rgb> = {
  Explore: 0x73c991,
  Plan: 0x7aa2f7,
  'general-purpose': 0xbb9af7,
  claude: 0xbb9af7,
  fork: 0xe0af68,
}
const SLIME_OTHER = 0xff8fab

// Half rows mirror into full rows, so the head stays symmetric.
const mirror = (half: string) => half + [...half].reverse().join('')

const EYES: Record<string, [string, string, string?]> = {
  open: ['occeeccc', 'occehccc'],
  blink: ['occccccc', 'occooccc'],
  down: ['occccccc', 'occeeccc'],
  happy: ['occcoccc', 'occococc'],
  sad: ['occococc', 'occcoccc', 'ocbpcccm'],
  sleep: ['occccccc', 'ocoooccc'],
}

function catHead(eyes: keyof typeof EYES): string[] {
  const [a, b, cheek] = EYES[eyes] ?? EYES.open!
  return [
    '..o.....',
    '.oco....',
    '.occo...',
    '.occcooo',
    'occccccc',
    'occccccc',
    a,
    b,
    cheek ?? 'ocppcccm',
    '.occcccc',
    '..oooooo',
  ].map(mirror)
}

// The body rows face right: the tail is on the left.
const BODY: Record<string, string[]> = {
  sit: ['oc.occwwwwcco...', 'oc.occwwwwcco...', '.coccwwwwwwcco..', '..occcccccccco..', '...oooo..oooo...'],
  walk1: ['oc.occwwwwcco...', 'oc.occwwwwcco...', '.coccwwwwwwcco..', '..occcccccccco..', '..oo..oo..oo..o.'],
  walk2: ['.o.occwwwwcco...', 'oc.occwwwwcco...', 'ococcwwwwwwcco..', '..occcccccccco..', '...oo..oo..oo...'],
  type1: ['oc.occwwwwccoKKK', 'oc.occwwwwccokgk', '.coccwwwwwwcokgk', '..occcccccccoKKK', '...oooo..oooo...'],
  type2: ['oc.occwwwwcco...', 'oc.occwwwwccoKKK', '.coccwwwwwwcokgk', '..occcccccccoKKK', '...oooo..oooo...'],
  read: ['oc.occwwwwnnnn..', 'oc.occwwwwnwwn..', '.coccwwwwwnnnn..', '..occcccccccco..', '...oooo..oooo...'],
  tuck: ['oc.occwwwwcco...', 'oc.occwwwwcco...', '.coccwwwwwwcco..', '..occcccccccco..', '....oooooooo....'],
}

const SLIME_A = ['....oo', '..ooss', '.osshs', '.ossss', 'osesss', 'osssps', 'osssss', '.ooooo'].map(mirror)
const SLIME_B = ['......', '...ooo', '.oossh', 'osssss', 'osesss', 'osssps', '.ooooo'].map(mirror)

export type Sprite = string[]

export const flip = (s: Sprite): Sprite => s.map(r => [...r].reverse().join(''))

// The cat's frame for a mood at a tick. Eyes blink about once each 4 seconds.
function catFrame(mood: PetMood, tick: number): { sprite: Sprite; lift: number } {
  const blink = tick % 27 === 0 || tick % 27 === 1
  const step = Math.floor(tick / 2) % 2
  switch (mood) {
    case 'walk':
    case 'run':
      return { sprite: [...catHead(blink ? 'blink' : 'open'), ...BODY[(mood === 'run' ? tick : step) % 2 ? 'walk1' : 'walk2']!], lift: 0 }
    case 'type':
      return { sprite: [...catHead('down'), ...BODY[step ? 'type1' : 'type2']!], lift: 0 }
    case 'read':
      return { sprite: [...catHead(blink ? 'blink' : 'down'), ...BODY.read!], lift: 0 }
    case 'happy': {
      const up = [0, 2, 3, 2][tick % 4] ?? 0
      return { sprite: [...catHead('happy'), ...BODY[up ? 'tuck' : 'sit']!], lift: up }
    }
    case 'sad':
      return { sprite: [...catHead('sad'), ...BODY.sit!], lift: 0 }
    case 'sleep':
      return { sprite: [...catHead('sleep'), ...BODY.sit!], lift: tick % 8 < 4 ? 0 : 1 }
    default:
      return { sprite: [...catHead(blink ? 'blink' : 'open'), ...BODY.sit!], lift: 0 }
  }
}

// The yard keeps the cat's place and heading between frames.
export type Yard = { x: number; dir: 1 | -1; tick: number }

export const newYard = (): Yard => ({ x: 4, dir: 1, tick: 0 })

const CAT_W = 16
const CAT_H = 16
export const YARD_ROWS = 9
export const YARD_H = YARD_ROWS * 2

// Move the cat one tick. Walking moves 1 pixel, running moves 2.
export function stepYard(y: Yard, mood: PetMood, width: number): void {
  y.tick += 1
  const speed = mood === 'run' ? 2 : mood === 'walk' ? 1 : 0
  const max = Math.max(0, width - CAT_W)
  if (!speed) {
    // At rest the cat drifts to a fixed place, so it does not stop on the edge.
    const home = Math.min(max, 2)
    if (mood === 'idle' || mood === 'sleep') y.x += Math.sign(home - y.x)
    return
  }
  y.x += speed * y.dir
  if (y.x >= max) {
    y.x = max
    y.dir = -1
  } else if (y.x <= 0) {
    y.x = 0
    y.dir = 1
  }
}

// The pixels of one frame: a grid of RGB values, NONE where nothing is drawn.
export type Pixels = { w: number; h: number; px: Int32Array; marks: { col: number; row: number; ch: string; rgb: Rgb }[] }

export const newPixels = (w: number, h: number): Pixels => ({ w, h, px: new Int32Array(w * h).fill(NONE), marks: [] })

export function paint(p: Pixels, sprite: Sprite, x0: number, y0: number, tint?: Rgb, pal: Record<string, Rgb> = PALETTE): void {
  sprite.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx]!
      if (ch === '.') continue
      const x = x0 + dx
      const y = y0 + dy
      if (x < 0 || y < 0 || x >= p.w || y >= p.h) continue
      const rgb = ch === 's' && tint !== undefined ? tint : pal[ch]
      if (rgb !== undefined) p.px[y * p.w + x] = rgb
    }
  })
}

export function drawYard(y: Yard, scene: PetScene, width: number): Pixels {
  const p = newPixels(width, YARD_H)
  const { sprite, lift } = catFrame(scene.mood, y.tick)
  // The sprites face right. A cat that walks left is flipped.
  const cat = y.dir < 0 && (scene.mood === 'walk' || scene.mood === 'run') ? flip(sprite) : sprite
  paint(p, cat, y.x, YARD_H - CAT_H - lift)
  // The slimes follow the cat in a line behind it. With no room behind, they lead.
  const slimes = scene.slimes.slice(0, 5)
  const behind = y.dir > 0 ? y.x - 14 * slimes.length >= 0 : y.x + CAT_W + 14 * slimes.length <= width
  slimes.forEach((type, i) => {
    const bounce = (y.tick + i * 2) % 4 < 2
    const s = bounce ? SLIME_A : SLIME_B
    const back = y.dir > 0 === behind ? -1 : 1
    const sx = back < 0 ? y.x - 14 * (i + 1) : y.x + CAT_W + 2 + 14 * i
    paint(p, s, sx, YARD_H - s.length, SLIME_TINT[type] ?? SLIME_OTHER)
  })
  // Text marks over the pixels: Zz for sleep, a ? while it thinks, a ! when it fails.
  const headCol = y.x + CAT_W
  if (scene.mood === 'sleep') {
    const t = y.tick % 12
    if (t >= 2) p.marks.push({ col: headCol, row: 2, ch: 'z', rgb: 0x7aa2f7 })
    if (t >= 6) p.marks.push({ col: headCol + 1, row: 1, ch: 'z', rgb: 0x7aa2f7 })
    if (t >= 9) p.marks.push({ col: headCol + 2, row: 0, ch: 'Z', rgb: 0x7aa2f7 })
  } else if (scene.mood === 'think') {
    p.marks.push({ col: headCol, row: 1, ch: y.tick % 6 < 3 ? '?' : '·', rgb: 0xe0af68 })
  } else if (scene.mood === 'sad') {
    p.marks.push({ col: headCol, row: 1, ch: '!', rgb: 0xf7768e })
  } else if (scene.mood === 'happy') {
    p.marks.push({ col: headCol, row: 1, ch: y.tick % 2 ? '*' : '+', rgb: 0x73c991 })
  }
  return p
}

// ---- terminal: Raster cells ----------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

const UPPER = 0x2580
const LOWER = 0x2584

export function rasterCells(p: Pixels): { cells: string; columns: number; rows: number } {
  const columns = p.w
  const rows = p.h / 2
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const top = p.px[2 * r * columns + c]!
      const bot = p.px[(2 * r + 1) * columns + c]!
      const i = (r * columns + c) * 3
      if (top === NONE && bot === NONE) {
        words.set([0x20, DEFAULT, DEFAULT], i)
      } else if (top === NONE) {
        words.set([LOWER, bot, DEFAULT], i)
      } else {
        words.set([UPPER, top, bot === NONE ? DEFAULT : bot], i)
      }
    }
  }
  for (const m of p.marks) {
    if (m.col < 0 || m.col >= columns || m.row < 0 || m.row >= rows) continue
    const i = (m.row * columns + m.col) * 3
    words.set([m.ch.codePointAt(0)!, m.rgb, DEFAULT], i)
  }
  return { cells: base64(new Uint8Array(words.buffer)), columns, rows }
}

// ---- remote surfaces: SVG ------------------------------------------------------------

const hex = (rgb: Rgb) => `#${rgb.toString(16).padStart(6, '0')}`

export function svgSource(p: Pixels, scale = 4): string {
  const rects: string[] = []
  for (let y = 0; y < p.h; y++) {
    let x = 0
    while (x < p.w) {
      const v = p.px[y * p.w + x]!
      if (v === NONE) {
        x += 1
        continue
      }
      let run = 1
      while (x + run < p.w && p.px[y * p.w + x + run] === v) run += 1
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${hex(v)}"/>`)
      x += run
    }
  }
  const texts = p.marks.map(
    m => `<text x="${m.col + 0.2}" y="${m.row * 2 + 1.8}" font-size="2.4" fill="${hex(m.rgb)}" font-family="monospace">${m.ch}</text>`,
  )
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.w} ${p.h}" width="${p.w * scale}" height="${p.h * scale}" ` +
    `shape-rendering="crispEdges">${rects.join('')}${texts.join('')}</svg>`
  )
}

// Words for a reader that cannot see the drawing.
export function petAlt(scene: PetScene): string {
  const what: Record<PetMood, string> = {
    idle: 'The cat sits and waits.',
    sleep: 'The cat sleeps.',
    think: 'The cat thinks.',
    walk: 'The cat walks.',
    run: 'The cat runs a command.',
    type: 'The cat types an edit.',
    read: 'The cat reads a file.',
    happy: 'The cat jumps: the turn is done.',
    sad: 'The cat is sad: a call failed.',
  }
  const n = scene.slimes.length
  return `${what[scene.mood]}${n ? ` ${n} subagent slime${n === 1 ? '' : 's'} follow it.` : ''}`
}

// One pet frame lasts this long, in milliseconds.
export const PET_MS = 150

// Bring the yard to the frame of a clock time. A long gap moves at most 20 frames.
export function advanceYard(y: Yard, mood: PetMood, width: number, now: number): void {
  const target = Math.floor(now / PET_MS)
  if (y.tick === 0 || target - y.tick > 20) y.tick = target - 20
  while (y.tick < target) stepYard(y, mood, width)
}
