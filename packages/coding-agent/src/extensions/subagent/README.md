# Subagents

A built-in extension that lets the model delegate tasks to subagents. Each subagent runs as a separate `pi --mode rpc` process with its own system prompt, tools, skill groups, and session file. Its work stays out of the parent's context; the parent gets the final answer.

## Agents

An agent is a Markdown file. The body is the agent's whole system prompt; Pi's default prompt is not included.

```markdown
---
name: symfony-dev
description: Implements Symfony features
model: anthropic/claude-sonnet-4-5   # optional; without it the parent's model and thinking level are used
tools: [edit, write, bash]            # added to the core tools
skillGroups: [php, testing]           # skill groups the agent can search
pinnedSkills: [symfony]               # optional; always listed in the agent's prompt
---

You are a Symfony developer...
```

`tools`, `skillGroups`, and `pinnedSkills` accept a YAML list or a comma-separated string.

Agents are loaded from two places:

| Location | When |
|---|---|
| `agents/*.md` in this directory | Always. Ships with the fork: `scout`, `planner`, `reviewer`, `worker`. |
| `.pi/subagents/agents/*.md` in the project or an ancestor directory | Only when the project is trusted. Replaces a bundled agent with the same name. |

## Tools

A subagent gets, in order:

1. The core tools from `config.json` in this directory (`read`, `grep`, `find`, `ls`). A trusted project can replace them with `.pi/subagents/config.json`.
2. The agent's `tools`.
3. The call's `extraTools`.
4. `skill_search` and `load_skill`, when the agent has skill groups.

Extension and MCP tools work when the child process loads the same extensions. The `subagent` tool is never passed to a subagent, so subagents cannot start further subagents.

## Skills

Subagent skills are grouped by directory and are separate from the main session's skills:

```
skills/<group>/<skill>/SKILL.md                 (bundled, in this directory)
.pi/subagents/skills/<group>/<skill>/SKILL.md   (trusted projects; adds to the bundled group)
```

A skill uses the usual `SKILL.md` frontmatter plus `tags`:

```markdown
---
name: symfony
description: Symfony 7 controllers, services, DI config, and console commands.
tags: [php, symfony]
---
```

- `name` and `description` follow the [Agent Skills](https://agentskills.io/specification) rules. A skill without a description is skipped. Other problems produce warnings, which the parent shows as notifications.
- `tags` is a list or a comma-separated string, lowercased. `metadata.tags` (a comma-separated string, valid under the Agent Skills spec) is merged in.
- The group comes from the directory. To put a skill in two groups, symlink it into both.

Skills are not pasted into the subagent's prompt. The prompt names the tags available in the agent's groups and lists its pinned skills. The subagent then:

- calls `skill_search` with a query and/or tags. Results are ranked by matching tags, then name matches, then text relevance, and each result has the skill's name, description, and tags. With no query, it lists every skill in its groups.
- calls `load_skill` to read one skill's instructions. It refuses skills outside the agent's groups.

`load_skill` limits what the subagent is pointed to. It is not a sandbox: an agent with `read` or `bash` can still read any file.

## The `subagent` tool

| Mode | Parameters |
|---|---|
| Single | `agent`, `task` |
| Parallel | `tasks: [{ agent, task }, ...]` (at most 8, 4 at a time) |
| Chain | `chain: [{ agent, task }, ...]`, where `{previous}` in a task is replaced by the previous step's output |
| Continue | `session` (a subagent's name, or a session file path plus `agent`), `task` |

Every new subagent also takes `name` and `description`, at the top level in single mode or per task:

- `name` is one word, such as `auth-scout`. It is lowercased and reduced to letters, digits, `-`, and `_`, and becomes the subagent's id: the agent view lists it, and `session` uses it to continue the subagent. A name already used in this session gets `-2`, `-3`, and so on. Without a name, the agent name is used.
- `description` says what the subagent is doing in 2-4 words, such as `Map auth flow`. Without one, the first words of the task are used.

Every mode accepts `cwd`, `extraTools`, and `extraSkillGroups`, at the top level or per task.

## Sessions

Each subagent keeps a normal Pi session file in `<parent session dir>/subagents/<parent session id>/`, named `<name>: <description>`. The tool result tells the parent model the subagent's name so it can send a follow-up with `session`. You can open any subagent session later with `pi --session <path>`. When the parent runs without a session file (`--no-session`), subagents do not keep one either.

The child process runs only while the subagent works. A follow-up starts a new process on the same session file.

## Agent view

Press `←` twice within 400 ms while the editor is empty (keybinding `app.agents.view`, configurable in `keybindings.json`). The view lists the main session and every subagent started in this session, each subagent by name, description, and agent. It starts on the session you last opened in it: the main session at first, then whichever subagent (or the main session) you opened most recently. Going back from a subagent returns to the list on that subagent.

| Key | List | Subagent |
|---|---|---|
| `↑` / `↓` | Select | |
| `Enter` | Open the selection (the main session closes the view) | Send the input: steers a running subagent, or starts a follow-up on an idle one |
| `Esc` | Close the view | Abort a running subagent, or go back to the list |
| `←←` | Close the view | Go back to the list (when the input is empty) |
| `PgUp` / `PgDn`, mouse wheel | Wheel moves the selection | Scroll the transcript |
| `Ctrl+Home` / `Ctrl+End` | | Jump to the top or bottom of the transcript |

The transcript scrolls like the fullscreen transcript. It uses the same configurable `tui.altScreen.*` keys (page, half-page, and line actions; the half-page and line actions have no default key). It follows new output until you scroll up, then holds its position and shows how many lines are below. Scrolling back to the bottom resumes following. The scrollbar follows the `fullscreenScrollbar` setting.

Dialogs from a subagent's extensions (confirm, select, input) appear in the parent, prefixed with the agent name.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Tools, run planning, and the agent-view trigger |
| `agents.ts` | Agent discovery |
| `skills.ts` | Skill groups, tags, and search |
| `child.ts` | One subagent process and its transcript |
| `rpc.ts` | RPC client for the child process |
| `registry.ts` | Subagents started in this session |
| `view.ts` | The agent view |
| `render.ts` | Tool call and result rendering |
| `paths.ts` | Bundled asset location and `config.json` |

The build copies `agents/`, `skills/`, and `config.json` to `dist/extensions/subagent/` and, for standalone binaries, to `subagent/` next to the executable (see `copy-assets` and `copy-binary-assets` in `package.json`).
