// TUI viewport parsing: ANSI stripping and interactive-menu detection.
// Pure heuristics over text — no terminal I/O happens here.

const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const CHARSET_PATTERN = /\x1b[()#%][0-9A-B*+]/g
const SINGLE_ESCAPE_PATTERN = /\x1b[@-Z\\-_=><]/g

export function stripAnsi(text) {
  return text
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(CHARSET_PATTERN, '')
    .replace(SINGLE_ESCAPE_PATTERN, '')
}

const MARKER_CHARS = '>❯▶›'
const MARKER_PATTERN = /^(\s*)([>❯▶›])(\s+)(\S.*)$/
const LOOSE_MARKER_PATTERN = /[>❯▶›]/
// SGR reverse video (parameter 7), alone or in a parameter list.
const INVERSE_PATTERN = /\x1b\[(?:[0-9;]*;)?7(?:;[0-9;]*)?m/

function indentOf(line) {
  return line.length - line.trimStart().length
}

// Contiguous block of candidate option lines around `anchorIndex`: lines at
// the anchor's content indentation with non-empty labels, plus other marked
// lines sharing the same content column.
function collectBlock(lines, anchorIndex, contentColumn) {
  let start = anchorIndex
  let end = anchorIndex
  const isCandidate = line => {
    const marked = MARKER_PATTERN.exec(line)
    if (marked) return marked[1].length + marked[2].length + marked[3].length === contentColumn
    return line.trim() !== '' && indentOf(line) === contentColumn
  }
  while (start > 0 && isCandidate(lines[start - 1])) start -= 1
  while (end < lines.length - 1 && isCandidate(lines[end + 1])) end += 1
  return { start, end }
}

function blockOptions(lines, start, end) {
  const options = []
  const markedIndexes = []
  for (let i = start; i <= end; i += 1) {
    const marked = MARKER_PATTERN.exec(lines[i])
    options.push({ index: options.length + 1, label: (marked ? marked[4] : lines[i].trim()).trim() })
    if (marked) markedIndexes.push(i - start)
  }
  return { options, markedIndexes }
}

function menu(lines, start, end, selectedIndex, confidence) {
  const { options } = blockOptions(lines, start, end)
  return { options, selectedIndex, confidence }
}

// Cursor-marker path: exactly one marked line inside a ≥2-line block is a
// high-confidence menu. Multiple marked lines, a lone candidate line, or
// markers found only mid-text are ambiguous → low confidence.
function markerMenu(lines) {
  const marked = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = MARKER_PATTERN.exec(lines[i])
    if (match) marked.push({ line: i, contentColumn: match[1].length + match[2].length + match[3].length })
  }
  if (marked.length > 0) {
    const anchor = marked[0]
    const { start, end } = collectBlock(lines, anchor.line, anchor.contentColumn)
    const { options, markedIndexes } = blockOptions(lines, start, end)
    const confidence = options.length >= 2 && markedIndexes.length === 1 ? 'high' : 'low'
    return { options, selectedIndex: markedIndexes[0] ?? 0, confidence }
  }
  // Mid-text markers: something menu-like exists but no usable cursor line.
  const loose = lines.findIndex(line => LOOSE_MARKER_PATTERN.test(line) && line.trim() !== '')
  if (loose === -1) return undefined
  const { start, end } = collectBlock(lines, loose, indentOf(lines[loose]))
  if (end - start < 1) return undefined
  return menu(lines, start, end, loose - start, 'low')
}

// Inverse-video path (fallback when no cursor markers exist): one SGR-7 line
// inside a ≥2-line block of same-indent siblings is a high-confidence menu.
// Needs the raw (pre-strip) text; clean/raw line correspondence holds because
// stripping never removes newlines.
function inverseMenu(cleanLines, rawText) {
  if (typeof rawText !== 'string') return undefined
  const rawLines = rawText.split('\n')
  const inverse = []
  for (let i = 0; i < rawLines.length && i < cleanLines.length; i += 1) {
    if (INVERSE_PATTERN.test(rawLines[i]) && cleanLines[i].trim() !== '') inverse.push(i)
  }
  if (inverse.length === 0) return undefined
  const anchor = inverse[0]
  const { start, end } = collectBlock(cleanLines, anchor, indentOf(cleanLines[anchor]))
  if (inverse.length > 1 || end - start < 1) {
    return menu(cleanLines, start, end, anchor - start, 'low')
  }
  return menu(cleanLines, start, end, anchor - start, 'high')
}

// Returns { options: [{ index (1-based), label }], selectedIndex (0-based),
// confidence } or undefined when nothing menu-like is on screen.
export function parseMenu(cleanText, rawText) {
  const lines = cleanText.split('\n')
  return markerMenu(lines) ?? inverseMenu(lines, rawText)
}

// Minimal key moves from one 0-based selection to another. Undefined target
// yields undefined; equal indexes yield no moves.
export function movementFor(selectedIndex, targetIndex) {
  if (targetIndex === undefined) return undefined
  const delta = targetIndex - selectedIndex
  if (delta === 0) return []
  return Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? 'DOWN' : 'UP'))
}
