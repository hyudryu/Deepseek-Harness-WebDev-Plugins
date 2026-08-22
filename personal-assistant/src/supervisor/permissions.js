// Tools the supervisor may call autonomously at Level-2. Everything else is
// refused until a later phase adds an approval flow.
export const AUTONOMOUS_TOOLS = Object.freeze([
  'sessions_list',
  'session_get',
  'session_send',
  'tui_snapshot',
  'tui_select', // navigation only; submit=true requires an approval flow
  'tui_keypress', // named keys only; CTRL_C/CTRL_D interrupts on a running process stay allowed at Level-2
  'github_pr_review_state',
  'watch_create',
  'watch_list',
  'watch_cancel',
])

// Spec §11 destructive operations. V1 exposes none of these as tools; the
// list documents what will require explicit user approval once exposed.
export const APPROVAL_REQUIRED = Object.freeze([
  'session_close',
  'watch_delete_all',
])

const AUTONOMY_LEVEL_TOOLS = Object.freeze({
  1: Object.freeze([]),
  2: AUTONOMOUS_TOOLS,
})

export function checkToolCall(name, args = {}, { autonomyLevel = 2 } = {}) {
  if ((name === 'tui_select' || name === 'tui_keypress') && args.submit === true) {
    return { allowed: false, reason: `tool "${name}" cannot submit terminal input without explicit user approval` }
  }
  if ((AUTONOMY_LEVEL_TOOLS[autonomyLevel] ?? AUTONOMOUS_TOOLS).includes(name)) return { allowed: true }
  if (APPROVAL_REQUIRED.some(entry => entry === name || entry.startsWith(`${name}:`))) {
    return { allowed: false, reason: `tool "${name}" is destructive and requires explicit user approval` }
  }
  return { allowed: false, reason: `tool "${name}" is not on the personal-assistant autonomy allow-list for level ${autonomyLevel}` }
}

// Level-2 enforcement seam: wraps every supervisor tool spec's callback with
// checkToolCall. V1 has no approval UI, so a refused call returns a
// structured refusal WITHOUT executing the callback.
export function enforcePermissions(specs, { autonomyLevel = 2, logger } = {}) {
  return specs.map(spec => ({
    ...spec,
    callback: async (input, ...rest) => {
      const decision = checkToolCall(spec.name, input, { autonomyLevel })
      if (!decision.allowed) {
        logger?.warn?.(`personal-assistant: refused ${spec.name}: ${decision.reason}`)
        return { ok: false, reason: 'approval_required', message: decision.reason }
      }
      return spec.callback(input, ...rest)
    },
  }))
}
