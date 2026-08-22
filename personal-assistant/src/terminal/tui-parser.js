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
  const visible = stripAnsi(line)
  return visible.length - visible.trimStart().length
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

function markerBlocks(lines) {
  const blocks = []
  const covered = new Set()
  for (let index = 0; index < lines.length; index += 1) {
    const match = MARKER_PATTERN.exec(lines[index])
    if (!match) continue
    const contentColumn = match[1].length + match[2].length + match[3].length
    const { start, end } = collectBlock(lines, index, contentColumn)
    const key = `${start}:${end}`
    if (covered.has(key)) continue
    covered.add(key)
    const { options, markedIndexes } = blockOptions(lines, start, end)
    blocks.push({ start, end, options, markedIndexes })
  }
  return blocks
}

// Cursor-marker path: choose the bottom-most cursor menu deterministically.
// Multiple cursor-marked blocks are ambiguous and downgraded to low.
function markerMenu(lines) {
  const blocks = markerBlocks(lines)
  if (blocks.length > 0) {
    const block = blocks.at(-1)
    const { options, markedIndexes, start, end } = block
    const selectedIndex = markedIndexes.length === 0 ? 0 : markedIndexes[markedIndexes.length - 1]
    const ambiguous = blocks.length > 1 || markedIndexes.length !== 1
    const confidence = (options.length >= 2 && !ambiguous) ? 'high' : 'low'
    return menu(lines, start, end, selectedIndex, confidence)
  }
  // Mid-text markers: something menu-like exists but no usable cursor line.
  const loose = lines.findIndex(line => LOOSE_MARKER_PATTERN.test(line) && line.trim() !== '')
  if (loose === -1) return undefined
  const { start, end } = collectBlock(lines, loose, indentOf(lines[loose]))
  if (end - start < 1) return undefined
  return menu(lines, start, end, loose - start, 'low')
}

function inverseBlocks(lines) {
  const blocks = []
  const covered = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    if (!INVERSE_PATTERN.test(lines[i])) continue
    const { start, end } = collectBlock(lines, i, indentOf(lines[i]))
    const key = `${start}:${end}`
    if (covered.has(key)) continue
    covered.add(key)
    const optionLines = lines.slice(start, end + 1)
    blocks.push({
      start,
      end,
      optionLines,
      inverseIndexes: optionLines
        .map((line, offset) => (INVERSE_PATTERN.test(line) ? offset : undefined))
        .filter(index => index !== undefined),
    })
  }
  return blocks
}

// Inverse-video path (fallback when no cursor markers exist): one SGR-7 line
// inside a ≥2-line block of same-indent siblings is a high-confidence menu.
// Needs the raw (pre-strip) text; clean/raw line correspondence holds because
// stripping never removes newlines.
function inverseMenu(cleanLines, rawText) {
  if (typeof rawText !== 'string') return undefined
  const rawLines = rawText.split('\n')
  const blocks = inverseBlocks(rawLines)
  if (blocks.length === 0) return undefined
  const block = blocks.at(-1)
  if (block.end - block.start < 1) return undefined
  const options = blockOptions(cleanLines, block.start, block.end).options
  const ambiguous = blocks.length > 1 || block.inverseIndexes.length !== 1
  const selectedIndex = block.inverseIndexes.length > 0 ? block.inverseIndexes[0] : 0
  if (options.length < 2) return undefined
  return menu(cleanLines, block.start, block.end, selectedIndex, ambiguous ? 'low' : 'high')
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
