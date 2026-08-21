// Deterministic friendly-name derivation from a session's first task text
// (or repo/branch when no task is known). Pure and stable: same input, same
// name. Collision suffixing lives in SessionIndex, not here.

// Politeness/request scaffolding stripped from the front, longest first.
const LEADING_PHRASES = [
  'i need you to', 'i want you to', 'i would like you to', 'can you please', 'could you please',
  'can you', 'could you', 'would you', 'please', 'help me to', 'help me', "let's", 'lets',
]

// Action verbs stripped from the front; they describe the instruction, not
// the subject. Verbs in VERB_SUFFIX convert to a trailing noun instead of
// vanishing ("migrate ..." → "... migration").
const LEADING_VERBS = [
  'implement', 'fix', 'add', 'create', 'update', 'refactor', 'remove', 'delete', 'build',
  'write', 'make', 'change', 'improve', 'enhance', 'introduce', 'develop', 'resolve',
  'address', 'handle', 'setup', 'migrate',
]

const VERB_SUFFIX = { migrate: 'migration' }

// Clause openers: everything from one of these (at word index ≥ 2) is
// context, not the core phrase ("fix auth redirect bug after login" →
// "auth redirect bug").
const CLAUSE_MARKERS = new Set(['after', 'before', 'when', 'while', 'because', 'since', 'unless', 'until'])

const LEADING_ARTICLES = new Set(['the', 'a', 'an'])

const MIN_WORDS = 2
const MAX_WORDS = 6

function clean(text) {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '')
    .toLowerCase()
}

function sentenceCase(phrase) {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

// Returns a 2–6 word sentence-case name, or undefined when the task text has
// no usable core phrase. Callers fall back to repo, then "Session <shortid>".
export function deriveFriendlyName({ task, repo, branch } = {}) {
  if (typeof task === 'string' && task.trim() !== '') {
    const name = fromTask(task)
    if (name !== undefined) return name
  }
  const fallback = typeof repo === 'string' && repo.trim() !== '' ? repo : branch
  if (typeof fallback === 'string' && fallback.trim() !== '') {
    return sentenceCase(clean(fallback.split('/').pop()))
  }
  return undefined
}

function fromTask(task) {
  let text = clean(task)
  const suffixes = []

  // Strip leading scaffolding repeatedly ("please can you fix ..." → "...").
  let changed = true
  while (changed) {
    changed = false
    for (const phrase of LEADING_PHRASES) {
      if (text === phrase || text.startsWith(`${phrase} `)) {
        text = text.slice(phrase.length).trim()
        changed = true
      }
    }
    const [first] = text.split(' ')
    if (LEADING_VERBS.includes(first)) {
      if (VERB_SUFFIX[first]) suffixes.push(VERB_SUFFIX[first])
      text = text.split(' ').slice(1).join(' ')
      changed = true
    }
    if (LEADING_ARTICLES.has(text.split(' ')[0])) {
      text = text.split(' ').slice(1).join(' ')
      changed = true
    }
  }

  let words = text.split(' ').filter(word => word !== '')

  // Drop trailing context clauses.
  const cut = words.findIndex((word, index) => index >= MIN_WORDS && CLAUSE_MARKERS.has(word))
  if (cut !== -1) words = words.slice(0, cut)

  // A suffix verb names the phrase after its object; with a long phrase the
  // trailing artifact word is redundant ("user preferences table migration"
  // → "user preferences migration").
  for (const suffix of suffixes) {
    if (words.length >= 3) words = words.slice(0, -1)
    words.push(suffix)
  }

  if (words.length < MIN_WORDS) return undefined
  if (words.length > MAX_WORDS) words = words.slice(0, MAX_WORDS)
  return sentenceCase(words.join(' '))
}
