import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Persistence for assistant state: per-session friendly/custom names and PR
// associations, plus the recent event-dedupe keys. Kept behind this tiny
// load/save seam so backends stay swappable and the pure logic tests against
// the memory store.
//
// Backend choice: plain JSON file. dsh-storage-domain (ctx.storageDomain)
// would require depending on the internal @deepseek-ai/dsh-storage-domain
// package (defineDomain + zod record schemas) and on the deployment having a
// configured storage backend — neither is cleanly available to an external
// plugin bundle in rc.6, so the file store is the default and the domain
// backend can slot in behind this interface later.

export const STATE_VERSION = 1
export const STATE_FILE_ENV = 'DSH_PERSONAL_ASSISTANT_STATE'

export function emptyState() {
  return { version: STATE_VERSION, sessions: {}, dedupeKeys: [], watches: [] }
}

function profileName(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile' && argv[index + 1]) return argv[index + 1]
    if (argv[index].startsWith('--profile=')) return argv[index].slice('--profile='.length)
  }
  return 'default'
}

export function defaultStatePath({ env = process.env, argv = process.argv, homeDir = homedir() } = {}) {
  if (env[STATE_FILE_ENV]) return resolve(env[STATE_FILE_ENV])
  const dshHome = env.DSH_HOME ? resolve(env.DSH_HOME) : join(homeDir, '.dsh')
  return join(dshHome, 'profiles', profileName(argv), 'personal-assistant-state.json')
}

export function createMemoryStore(initial) {
  const state = initial ?? emptyState()
  return {
    state,
    save() {},
    async flush() {},
  }
}

// save() is debounced; flush() forces an immediate durable write (used on
// plugin dispose). Writes go through a temp file + rename so a crash mid-write
// never leaves a truncated state file.
export function createJsonFileStore({ filePath = defaultStatePath(), debounceMs = 500, logger } = {}) {
  let state = emptyState()
  try {
    state = { ...emptyState(), ...JSON.parse(readFileSync(filePath, 'utf8')) }
  } catch {
    // Missing or corrupt state file: start fresh rather than fail startup.
  }

  let timer
  let writing = Promise.resolve()

  async function writeNow() {
    const snapshot = JSON.stringify(state, null, 2)
    writing = writing.then(async () => {
      await mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await writeFile(tmp, snapshot)
      await rename(tmp, filePath)
    }).catch(error => {
      logger?.warn?.(`personal-assistant: could not persist state: ${error instanceof Error ? error.message : String(error)}`)
    })
    return writing
  }

  return {
    state,
    filePath,
    save() {
      clearTimeout(timer)
      timer = setTimeout(() => writeNow(), debounceMs)
      timer.unref?.()
    },
    async flush() {
      clearTimeout(timer)
      await writeNow()
    },
  }
}
