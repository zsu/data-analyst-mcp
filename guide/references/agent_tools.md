# Actions and the tools that do them, per assistant

SKILL.md names actions, not tools. Use what your tool list actually offers; this table only says where to
look. Where no tool exists, the right-hand fallback applies.

| Action in SKILL.md | Claude Code (terminal, desktop) | claude.ai, Cowork | Codex (CLI, app) | Any other assistant |
|---|---|---|---|---|
| `<skill>` (this skill's folder) | `${CLAUDE_SKILL_DIR}`, expanded in SKILL.md | the folder SKILL.md was loaded from | the folder SKILL.md was loaded from (the plugin cache) | the folder SKILL.md was loaded from |
| Ask with your question tool | `AskUserQuestion` | the question or choices tool when offered | no question tool: one chat message | one chat message |
| Send a file | `SendUserFile` when offered, else print the path | `present_files` | print the path (the app links it) | print the path |
| Web search / fetch (§2b) | `WebSearch`, `WebFetch` (load them if deferred) | the web search tool | the web search tool when enabled (`--search`, or `web_search` in config.toml) | any search or fetch tool; none: record `no_search_tool` |
| Run `fetch.py` and the audits | Bash / PowerShell | code execution | the shell tool | any shell or code tool; none: say Python is missing |
| Deliverables folder (`<out>`) | `out/<short-name>/` in the directory the session started in (never above it), or the folder the environment names | the outputs folder the environment names | `out/<short-name>/` in the directory the session started in | `out/<short-name>/`, or `$DATA_ANALYST_OUT` |

When asking in a chat message (no question tool): one message, at most 4 numbered questions, each with
lettered options, the recommended one first, and a "Don't know — decide for me" option, exactly as §1 says.

## Environment and network
`fetch.py --check` detects the environment and picks the route; override with `--env` or
`DATA_ANALYST_ENV` (`local`, `ssh`, `cloud`, `sandbox`) when the guess is wrong.

| Assistant | Detected as | Network and keys |
|---|---|---|
| Claude Code on the user's computer | `local` / `ssh` | full network; keys from the setup script |
| Claude Code cloud (`CLAUDE_CODE_REMOTE`) | `cloud` | keys go in the environment's secrets; hosts may need allowlisting |
| claude.ai, Cowork | `sandbox` | keyless hosts only if the organization allows them; otherwise manual download |
| Codex CLI or app on the user's computer | `local` | Codex's sandbox may block network (`CODEX_SANDBOX_NETWORK_DISABLED=1`): the error message says so; the user approves the command with network access or sets `sandbox_workspace_write.network_access = true` |
| Codex cloud, ChatGPT | `sandbox` | keyless hosts only if the environment allows internet access; otherwise manual download |

## Keys
The setup script (`setup.ps1 -Source <id>` / `setup.sh <id>`, run by the user in their own terminal) stores a
key in `~/.config/data-analyst/keys.json` (or `$DATA_ANALYST_CONFIG_DIR`), which the skill reads directly
under every assistant; no restart, nothing loaded into the environment. If the key variable is already set
in the user's environment, the script stores nothing: the skill uses the variable. Keys stored earlier in
Claude Code's `settings.json` still work. Never ask for a key in chat.
