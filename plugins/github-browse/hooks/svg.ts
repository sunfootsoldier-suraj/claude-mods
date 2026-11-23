import type { Stop } from '../types'

const LINE_H = 20
const CHAR_W = 7.9
const PAD_X = 12
const MIN_COLS = 40
const MAX_COLS = 110

const KEYWORDS = new Set(
  (
    'abstract as assert async await break case catch except class const continue def default del delete do elif else enum export extends ' +
    'false final finally fn for from func function global go if impl implements import in interface is lambda let match mod ' +
    'module mut new nil none None not null or package pass private protected pub public raise return self Self static struct ' +
    'super switch this throw throws true True False try type typeof use var void while with yield'
  ).split(' '),
)

const TOKEN =
  /(\/\/.*$|#.*$|--\s.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.xXa-fA-F]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g

const STYLE = `
.bg{fill:#ffffff}.hd{fill:#f6f8fa}.bd{stroke:#d0d7de}.tx{fill:#1f2328}.mu{fill:#59636e}.gn{fill:#8c959f}
.hl{fill:#fff8c5}.bar{fill:#d4a72c}.k{fill:#cf222e}.s{fill:#0a3069}.c{fill:#6e7781;font-style:italic}
.n{fill:#0550ae}.f{fill:#8250df}.hlgn{fill:#1f2328}
@media (prefers-color-scheme: dark){
.bg{fill:#0d1117}.hd{fill:#151b23}.bd{stroke:#3d444d}.tx{fill:#e6edf3}.mu{fill:#9198a1}.gn{fill:#6e7681}
.hl{fill:#bb800926}.bar{fill:#d29922}.k{fill:#ff7b72}.s{fill:#a5d6ff}.c{fill:#8b949e}
.n{fill:#79c0ff}.f{fill:#d2a8ff}.hlgn{fill:#e6edf3}}
text{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;font-size:12px;white-space:pre}
.ui{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12.5px}
.b{font-weight:600}`

type Line = { no: number; text: string; isFocus: boolean }

export function codeSvg(stop: Stop, shownPath: string, paneCols: number): { source: string; width: number; height: number } {
  const lines: Line[] = []
  for (const [part, isFocus] of [
    [stop.before, false],
    [stop.focus, true],
    [stop.after, false],
  ] as const) {
    if (!part) continue
    part.text.split('\n').forEach((text, i) => lines.push({ no: part.start + i, text, isFocus }))
  }

  const lastNo = lines.at(-1)?.no ?? 1
  const digits = Math.max(3, String(lastNo).length)
  const gutterW = digits * CHAR_W + PAD_X * 2
  const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, paneCols - digits - 4))
  const rows: { no?: number; text: string; isFocus: boolean; isComment?: boolean }[] = []
  for (const line of lines) {
    const text = expandTabs(line.text)
    if (text.length <= cols) {
      rows.push({ no: line.no, text, isFocus: line.isFocus })
      continue
    }
    const indent = Math.min(text.length - text.trimStart().length, Math.floor(cols / 2))
    const step = cols - indent - 2
    const commentAt = text.search(/(^|\s)(#|\/\/)/)
    let at = 0
    let room = cols
    let first = true
    while (at < text.length) {
      let end = Math.min(text.length, at + room)
      if (end < text.length) {
        const cut = Math.max(text.lastIndexOf(' ', end), text.lastIndexOf(',', end - 1) + 1, text.lastIndexOf('(', end - 1) + 1)
        if (cut > at + room / 2) end = cut
      }
      const piece = text.slice(at, end)
      rows.push(
        first
          ? { no: line.no, text: piece, isFocus: line.isFocus }
          : { text: ' '.repeat(indent + 2) + piece.trimStart(), isFocus: line.isFocus, isComment: commentAt >= 0 && commentAt < at },
      )
      at = end
      room = step
      first = false
    }
  }

  const hasFocus = rows.some(r => r.isFocus)
  const longest = Math.max(...rows.map(r => r.text.length), 20)
  const width = Math.round(gutterW + PAD_X + Math.min(cols, longest) * CHAR_W + PAD_X)
  const height = rows.length * LINE_H + 4

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>${STYLE}</style>`,
  ]

  rows.forEach((row, i) => {
    const y = 2 + i * LINE_H
    if (row.isFocus) {
      out.push(`<rect class="hl" x="0" y="${y}" width="${width}" height="${LINE_H}"/>`)
      out.push(`<rect class="bar" x="0" y="${y}" width="2" height="${LINE_H}"/>`)
    }
    const fade = hasFocus && !row.isFocus ? ' opacity="0.45"' : ''
    const base = y + 14
    out.push(
      `<g${fade}><text x="${gutterW - PAD_X}" y="${base}" text-anchor="end" class="gn">${row.no ?? ''}</text>`,
      `<text x="${gutterW}" y="${base}" class="tx">${row.isComment ? `<tspan class="c">${esc(row.text)}</tspan>` : highlight(row.text)}</text></g>`,
    )
  })

  out.push('</svg>')

  return { source: out.join(''), width, height }
}

function highlight(text: string): string {
  let html = ''
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0
    html += esc(text.slice(last, at))
    const [whole, comment, str, num, fn, word] = m
    const cls = comment
      ? 'c'
      : str
        ? 's'
        : num
          ? 'n'
          : fn
            ? KEYWORDS.has(fn) ? 'k' : 'f'
            : word && KEYWORDS.has(word)
              ? 'k'
              : ''
    html += cls ? `<tspan class="${cls}">${esc(whole)}</tspan>` : esc(whole)
    last = at + whole.length
  }

  return html + esc(text.slice(last))
}

function expandTabs(s: string): string {
  return s.replace(/\t/g, '    ')
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
