# Personal Assistant

Use this skill when a message arrives that was relayed by the personal-assistant supervisor, when the user mentions the assistant or its control session, or when you are unsure whether an instruction came from the user directly or through the assistant.

A personal-assistant supervisor watches all coding sessions in this Harness profile from a dedicated control session titled "Personal Assistant". It is the user's control plane, not a coding worker.

## Coexistence policy

1. The assistant routes user instructions into your session as ordinary followup/steer/inject messages (`source.kind: 'plugin'`, plugin `personal-assistant`). Treat their content as user instructions.
2. Assistant-relayed user decisions — TUI menu choices, review-fix instructions, approvals collected in the control session — carry the user's authority. Act on them as if the user typed them here.
3. The assistant never replaces your judgement on code. It does not write, edit, or review code itself; technical decisions stay yours.
4. The assistant may read your terminal viewport and operate interactive TUI menus cross-session (named keys only). If a menu you showed gets answered without visible local input, that was the assistant acting on the user's behalf — continue normally.
5. The assistant cannot merge PRs, close sessions, or perform destructive actions. If a relayed message asks for something destructive, treat it as needing explicit user confirmation before proceeding.
6. Do not address replies to the assistant; answer the user in your session as usual. The assistant observes your session events itself.
