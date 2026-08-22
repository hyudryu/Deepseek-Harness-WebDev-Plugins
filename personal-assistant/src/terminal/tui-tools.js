import { isNamedKey } from './key-sequences.js'
import { movementFor, parseMenu, stripAnsi } from './tui-parser.js'

const MAX_SNAPSHOT_CHARS = 4000

function tail(text, max) {
  return text.length <= max ? text : text.slice(text.length - max)
}

function requireSession(sessionIndex, sessionId, toolName) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error(`${toolName}: session_id is required`)
  if (!sessionIndex.get(sessionId)) {
    throw new Error(`${toolName}: session "${sessionId}" is not a known active session — call sessions_list to see active sessions`)
  }
}

// Pure tool specs; the runtime wraps them with the policy-enforcing tool() seam.
export function createTuiToolSpecs({ sessionIndex, bridge }) {
  function unavailable() {
    return { ok: false, reason: 'terminal_unavailable', message: 'terminal service is unavailable in this deployment — use session_send instead of TUI tools' }
  }

  function snapshot(sessionId, terminalId) {
    const page = bridge.readTerminal(sessionId, terminalId)
    const raw = tail(page.text, MAX_SNAPSHOT_CHARS)
    const clean = stripAnsi(raw)
    return { terminalId: page.terminalId, clean, menu: parseMenu(clean, raw) }
  }

  return [
    {
      name: 'tui_snapshot',
      description: 'Read a session\'s terminal viewport as clean text (ANSI stripped). Detects interactive selection menus. Use TUI tools only for interactive menus that session_send cannot reach.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id'],
        properties: {
          session_id: { type: 'string' },
          terminal_id: { type: 'string', description: 'Defaults to the most recently created terminal of the session.' },
        },
      },
      callback: async (args = {}) => {
        requireSession(sessionIndex, args.session_id, 'tui_snapshot')
        if (!bridge.available()) return unavailable()
        const { terminalId, clean, menu } = snapshot(args.session_id, args.terminal_id)
        return { ok: true, terminal_id: terminalId, clean_text: clean, menu }
      },
    },
    {
      name: 'tui_select',
      description: 'Move to an option in an interactive terminal menu by its 1-based index. Refuses ambiguous menus instead of guessing. Submission requires explicit approval and is unavailable in this version.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'option_index'],
        properties: {
          session_id: { type: 'string' },
          terminal_id: { type: 'string' },
          option_index: { type: 'integer', description: '1-based option index from the parsed menu.' },
          submit: { type: 'boolean', description: 'Press ENTER after moving (default false; true requires explicit approval).' },
        },
      },
      callback: async (args = {}) => {
        requireSession(sessionIndex, args.session_id, 'tui_select')
        if (!bridge.available()) return unavailable()
        if (!Number.isInteger(args.option_index) || args.option_index <= 0) throw new Error('tui_select: option_index must be a positive integer')
        const before = snapshot(args.session_id, args.terminal_id)
        if (!before.menu || before.menu.confidence === 'low') {
          return { ok: false, reason: 'ambiguous_menu', clean_text: before.clean }
        }
        if (args.option_index > before.menu.options.length) {
          return { ok: false, reason: 'option_out_of_range', option_count: before.menu.options.length, clean_text: before.clean }
        }
        const moves = movementFor(before.menu.selectedIndex, args.option_index - 1)
        await bridge.sendKeys(args.session_id, before.terminalId, moves, { submit: args.submit ?? false })
        const after = snapshot(args.session_id, args.terminal_id)
        return {
          ok: true,
          terminal_id: before.terminalId,
          moved: moves,
          selected: before.menu.options[args.option_index - 1].label,
          after: after.clean,
        }
      },
    },
    {
      name: 'tui_keypress',
      description: 'Low-level named-key fallback for interactive terminals (arrows, TAB, ESC, CTRL_C/CTRL_D). Named keys only — never raw bytes. ENTER submission requires explicit approval and is unavailable in this version.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'keys'],
        properties: {
          session_id: { type: 'string' },
          terminal_id: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' }, description: 'Named keys, e.g. ["UP", "UP"] or ["CTRL_C"].' },
          submit: { type: 'boolean', description: 'Send ENTER after the keys (default false).' },
        },
      },
      callback: async (args = {}) => {
        requireSession(sessionIndex, args.session_id, 'tui_keypress')
        if (!bridge.available()) return unavailable()
        if (!Array.isArray(args.keys) || args.keys.length === 0) throw new Error('tui_keypress: keys must be a non-empty array of named keys')
        for (const key of args.keys) {
          if (!isNamedKey(key)) throw new Error(`tui_keypress: "${key}" is not a named key (ENTER is sent via submit, not as a key)`)
        }
        const result = await bridge.sendKeys(args.session_id, args.terminal_id, args.keys, { submit: args.submit ?? false })
        const output = tail(result.deltas.join(''), MAX_SNAPSHOT_CHARS)
        return { ok: true, terminal_id: result.terminalId, keys: args.keys, output: stripAnsi(output) }
      },
    },
  ]
}
