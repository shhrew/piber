#!/usr/bin/env bash
# Runs pi-test.sh with a scenario prompt for testing a feature by hand.
# Runs the built CLI, rebuilding first when sources changed: from source, pi and every subagent start several times slower.
# Usage: ./piber-test.sh <scenario> [pi-test.sh args...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 <scenario> [pi-test.sh args...]"
  echo
  echo "Scenarios:"
  echo "  chat    Subagent chat: subagent to subagent, reply waits, replies by message id, held messages, broadcast"
  echo "  skills  Skill search: listing, query and tag ranking, no match, load_skill, tool gating, extraSkillGroups"
  echo "  control Subagent control: start now, pause, resume, terminate, handback, held chat for paused subagents"
  echo "  render  Tool rendering: chat_peers, skill_search, load_skill in the main session and the agent view"
  echo "  visibility  Prompt visibility: the orchestrator's agent list, and each agent's tools and skills sections"
  echo "  findings  Subagent findings: priority delivery, wait interruption, ownership, updates, list/get, result summaries"
  echo "  credentials  Subagent credentials: broadcast to orchestrator and all subagents, held for queued, list/get, persistence"
}

chat_prompt() {
  cat <<'EOF'
This is a manual test of the subagent chat feature. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either. Every chat message has a numeric id, shown in its <agent_message id="..."> tag; tell every subagent to answer a message with chat_send replyTo set to that id, leaving out to.

1. In ONE `subagent` call with `background: true`, start these three `worker` subagents in parallel (only two run at once, so charlie should start queued):
   - name "alpha", task: Do not edit files. Run `grep -rn "class ChatHub" packages/coding-agent/src`. Send the file and line to the orchestrator with chat_send and waitForReply: true, asking "Found ChatHub. Should I also look for ChatClient?". If the answer is yes, find ChatClient the same way. bravo will ask you two questions: answer each one in its own chat_send with replyTo set to that question's id, the first question first. Answer any other message that is waiting for your reply the same way. If your wait ends before the orchestrator answers, ask it again with waitForReply. Do not finish until you have the orchestrator's answer. Finish with what you found and every chat message you received, with its sender, id, and reply_to if it had one.
   - name "bravo", task: Do not edit files. Send alpha, without waiting: "Question 1: which file defines ChatClient?". Then ask alpha with chat_send and waitForReply: true: "Question 2: which file defines ChatHub?". Note the id of each message you sent. If your wait ends early, say why, quoting the tool result. Once you have answers to both questions, run `grep -rn "class ChatBubble" packages/coding-agent/src` and send the result to alpha without waiting. Finish with the ids of your two questions, the answer to each and the reply_to it carried, and every chat message you received, with its sender, id, and reply_to if it had one.
   - name "charlie", task: Do not edit files. First list the chat messages you have already received. Then send "charlie is running" to "all", and note its id. Then run `sleep 30` with bash. Finish with every chat message you received, with its sender, id, and reply_to if it had one.
2. Right after that call returns, send charlie, without waiting: "Held message: you were queued when this was sent." Then call chat_peers.
3. Call chat_send with replyTo 999 and text "test". It should be refused, since no message 999 exists. Quote the result verbatim.
4. Call subagent_wait with no names. A chat message to you ends the wait early; answer it, then call subagent_wait again to keep waiting, until all three have finished.
5. When alpha asks its question, answer "yes" with chat_send and replyTo set to the id of alpha's question, without to. When charlie's broadcast reaches you, answer "Got it, charlie" with replyTo set to the broadcast's id, without to. Answer any other message that is waiting for your reply with a short acknowledgement, using replyTo.
6. Once all three have finished, read their results with subagent_result. Then give a checklist of chat paths, each marked worked or failed with the evidence:
   - subagent to subagent (bravo to alpha, without waiting)
   - subagent to subagent with waitForReply (bravo asks alpha)
   - subagent to orchestrator with waitForReply (alpha asks you)
   - orchestrator to subagent by replyTo (your reply to alpha carries reply_to equal to its question's id, and ended alpha's wait)
   - subagent replies by id (alpha answered each of bravo's questions with a reply_to matching that question's id)
   - a reply to a different message ended a wait early ("replying to message N"), if it happened
   - reply to a broadcast (only charlie got your answer, with reply_to equal to its broadcast's id)
   - refused replyTo (step 3: "There is no message 999.")
   - held message for a queued subagent (charlie)
   - broadcast (charlie to all)
   - a reply wait ended early by another message, if it happened
   - subagent_wait ended early by a chat message, and waiting again afterwards
EOF
}

skills_prompt() {
  cat <<'EOF'
This is a manual test of subagent skill search. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either. Tell every subagent to quote each tool result verbatim in its final answer.

The bundled "review" skill group holds two skills:
- review-checklist, tags [review, quality, tests]
- security-review, tags [review, security], description mentions path traversal

1. In ONE `subagent` call with `background: false`, run these three subagents in parallel:
   - `reviewer`, name "rex", task: Do not edit files and do not review any code. Make these calls in order and quote each result verbatim:
     a. skill_search with no arguments
     b. skill_search with query "path traversal"
     c. skill_search with tags ["security"]
     d. skill_search with tags ["review"] and limit 1
     e. skill_search with query "kubernetes"
     f. load_skill with name "security-review"
     g. load_skill with name "does-not-exist"
     Also quote the <skills> section and the "Pinned skills" section of your system prompt verbatim.
   - `scout`, name "sam", task: Do not edit files. List the names of every tool you have. State whether skill_search and load_skill are among them. Do not call any other tool.
   - `scout`, name "sky", with `extraSkillGroups: ["review"]`, task: Do not edit files. List the names of every tool you have. Then call skill_search with query "tests" and quote the result verbatim.
2. Give a checklist, each item marked worked or failed with the evidence:
   - rex (a): lists both skills, in name order, with tags
   - rex (b): security-review is the first match
   - rex (c): only security-review
   - rex (d): exactly one result
   - rex (e): "No skills matched", followed by the available tags (quality, review, security, tests)
   - rex (f): returns the security-review body inside a <skill name="security-review" directory="..."> wrapper
   - rex (g): an error saying the skill is not available
   - rex prompt: <skills> lists the tags and both skills by name and description only, and "Pinned skills" names review-checklist
   - sam: has neither skill_search nor load_skill
   - sky: has skill_search and load_skill, and query "tests" returns review-checklist first
EOF
}

control_prompt() {
  cat <<'EOF'
This is a manual test of subagent_control. It assumes the default maxConcurrent of 4. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either. After each step, quote the tool result verbatim before going on.

1. In ONE `subagent` call with `background: true`, start these six `worker` subagents in this order:
   - names "w1", "w2", "w3", "w4", each with task: Do not edit files. Run `sleep 90` with bash. Then finish with: every message or notice you received from the orchestrator or the subagent system, quoted verbatim, and whether your sleep finished or was interrupted.
   - names "w5", "w6", each with task: Do not edit files. Run `sleep 20` with bash, then `echo <your name> done`, and finish with its output.
   w5 and w6 should start queued.
2. Call subagent_list.
3. Call subagent_control with action "start" and names ["w6"].
4. Call subagent_control with action "pause" and names ["w1"].
5. Call subagent_list at once. w5 should still be queued: the slot w1 freed covers w6, which started past the limit.
6. Send w1 with chat_send, without waiting: "Held message: sent while you were paused."
7. Call subagent_wait with names ["w1"]. It should return at once, since w1 is paused.
8. Call subagent_control with action "pause" and names ["w3"], then with action "handback", names ["w3"], and message "Say what you were doing when you were paused."
9. Call subagent_control with action "terminate" and names ["w4"].
10. Call subagent_control with action "handback" and names ["w2"]. w2 is in the middle of its sleep, so it only sees the request once the sleep ends.
11. Call subagent_control with action "resume", names ["w1"], and message "Skip the rest of your sleep and finish now."
12. Call subagent_wait with no names until every subagent has finished. If a chat message ends the wait early, answer it briefly and wait again.
13. Read every result with subagent_result. Then give a checklist, each item marked worked or failed with the evidence:
   - step 2: 4 running, 2 queued (w5, w6)
   - start: w6 "started ahead of the queue", slots 5 of 4 in use
   - pause: w1 "paused; its slot is free", slots 4 of 4 in use with 1 queued
   - step 5: w1 paused and w5 still queued
   - held chat: chat_send said it was held because w1 is paused, and w1's result quotes the held message
   - wait on a paused subagent: returned at once with "Paused, so not waited for: w1"
   - pause then handback: w3's result quotes the handback request and its note, and reports its work so far
   - handback while running: w2's result quotes the handback request, after its sleep finished
   - terminate: w4 ended as aborted
   - resume: w1's result quotes the resume notice with the note "Skip the rest of your sleep and finish now."
   - queue: w5 started and finished
EOF
}

render_prompt() {
  cat <<'EOF'
This is a manual test of how tool calls are drawn. A human checks the screen; you only make the calls. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either.

1. Call chat_peers. No subagents exist yet.
2. In ONE `subagent` call with `background: true`, start these three subagents in parallel:
   - `reviewer`, name "rex", task: Do not edit files and do not review any code. Make these calls in order, then finish with "rex done":
     a. skill_search with no arguments
     b. skill_search with query "path traversal", tags ["security"], and limit 3
     c. skill_search with query "kubernetes"
     d. load_skill with name "security-review"
     e. load_skill with name "does-not-exist"
     f. chat_peers
   - `worker`, name "wendy", task: Do not edit files. Run `sleep 45` with bash, then finish with "wendy done".
   - `scout`, name "quick", task: Do not edit files and do not call any tool. Finish with "quick done".
3. Call chat_peers again right away.
4. Call subagent_wait with names ["quick"], then call chat_peers once more.
5. Call subagent_wait with no names until every subagent has finished.
6. Finally, print this checklist verbatim for the human tester, and nothing else:

Main session (click a tool call or press the expand key to expand it):
- [ ] step 1 chat_peers: `⎿  No other subagents yet`
- [ ] step 3 chat_peers: `⎿  ● rex · ● wendy · ● quick · all`; expanded, one row each with description, agent, and state
- [ ] step 4 chat_peers: quick shows `○` (finished)
Agent view (open rex):
- [ ] a: `● Search skills(all)` then `⎿  2 matches · review-checklist, security-review`; expanded, rows with description and #tags
- [ ] b: `● Search skills(path traversal) #security · up to 3`, security-review first
- [ ] c: `● Search skills(kubernetes)` then `⎿  No match · try #quality #review #security #tests`
- [ ] d: `● Load skill(security-review)` then `⎿  N lines · <description>`; expanded, the skill directory and body
- [ ] e: red bullet, `⎿  Skill "does-not-exist" is not available. Use skill_search.` in red
- [ ] f: `● List chat peers` then `⎿  orchestrator`
- [ ] no tool call in rex or wendy is drawn as a green text block
EOF
}

visibility_prompt() {
  cat <<'EOF'
This is a manual test of what the orchestrator and each subagent can see in their system prompts. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either.

1. Quote these sections of your own system prompt verbatim, or say that a section is missing: <skills>, <subagents>. Then list the name of every tool in your tool definitions.
2. In ONE `subagent` call with `background: false`, run one subagent for every agent listed in your <subagents> section, in parallel. Name each after its agent. Give each this task:
   Do not edit files and do not call any tool. Answer only from your system prompt and tool definitions:
   a. Quote these sections of your system prompt verbatim, or say that a section is missing: <rules>, <skills>, <subagents>, and any "Pinned skills" section.
   b. List the name of every tool in your tool definitions.
   c. List the name of every skill you can see.
3. Give a table with one row for the orchestrator and one per subagent: its tools, its skills, and which of the sections above it has.
4. Give a checklist, each item marked worked or failed with the evidence:
   - orchestrator: <subagents> lists every agent with a description, and you ran one subagent for each
   - every subagent: no subagent tool, and no <subagents> section
   - every subagent: has a <rules> section
   - every subagent with skills: has skill_search and load_skill, and its <skills> lists each skill by name and description only (no file paths)
   - every subagent without skills: no <skills> section, no "Pinned skills" section, and neither skill_search nor load_skill
   - every "Pinned skills" section names only skills listed in that subagent's <skills>
EOF
}

findings_prompt() {
  cat <<'EOF'
This is a manual test of subagent findings. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either. Tell every subagent to quote each tool result verbatim in its final answer. After each step, quote your own tool results verbatim before going on.

1. In ONE `subagent` call with `background: true`, start these three `worker` subagents in parallel:
   - name "alpha", task: Do not edit files. Make these calls in order:
     a. add_finding with key "auth.token-cache", priority "critical", description "Session tokens are never invalidated on logout", metadata {file: "src/cache.ts", line: 42, confirmed: true}
     b. add_finding with key "docs.typo", priority "low", description "Typo in README", metadata {file: "README.md", line: 3}
     c. update_finding on your finding from (b), with metadata {line: 4, file: null}
     d. run `sleep 15` with bash
     e. update_finding on your finding from (b), with priority "high" and description "The typo is in a public API name"
     f. run `sleep 15` with bash
     Finish with the id of each finding you added and every tool result.
   - name "bravo", task: Do not edit files. Run `sleep 10` with bash first. Then:
     a. list_findings with no arguments
     b. get_finding with the id of alpha's "auth.token-cache" finding
     c. update_finding on that finding with priority "low". It should be refused, since alpha owns it.
     d. add_finding with key "Chat Hub Socket!", priority "medium", description "The hub socket is created lazily", metadata {file: "chat.ts"}
     e. list_findings with minPriority "high"
     Finish with every tool result.
   - name "charlie", task: Do not edit files. Call add_finding with key "misc.note", priority "low", description "Nothing urgent". Finish with its result.
2. Call subagent_wait with no names. A finding or chat message may end the wait early: quote the heading, call get_finding for each finding id it names, then call subagent_wait again, until all three have finished.
3. Call update_finding on alpha's "auth.token-cache" finding with priority "low". It should be refused: you do not own it.
4. Call list_findings with no arguments, then with from "alpha", then with key "auth".
5. Read every result with subagent_result.
6. Give a checklist, each item marked worked or failed with the evidence:
   - ids are integers counting up from 1 across all three subagents
   - alpha's critical finding reached you as a notice with id, key, priority, and sender only (no description or metadata), and ended subagent_wait early
   - alpha's low finding (b) and its first update (c) did not notify you
   - alpha's update (e) raising low to high notified you again, with revision 3, and ended subagent_wait early
   - update (c) merged metadata: line is 4 and file is gone
   - bravo's medium finding reached you on a later turn, not as a wake, and did not end subagent_wait
   - charlie's low finding never notified you
   - bravo's key "Chat Hub Socket!" was stored normalized as "chat-hub-socket"
   - bravo could list and get alpha's findings, but its update_finding on alpha's finding was refused
   - your update_finding (step 3) was refused
   - list_findings filters: minPriority "high", from "alpha", and key "auth" each returned only matching findings, sorted by priority then id
   - each subagent_result ends with a summary of that subagent's findings (id, priority, key), including charlie's low one
7. Finally, print this checklist verbatim for the human tester:

- [ ] main chat: each finding notice is one line, `⚑ #N <priority> · <sender> · <key>`, colored by priority
- [ ] main chat: add_finding / update_finding / get_finding / list_findings calls are drawn as compact `●` lines, not text blocks
- [ ] dock: alpha's row shows a ⚑ badge with its count, in the critical color
- [ ] agent view, Findings tab (→ twice from Agents): every finding listed by priority, with sender, key, and description; Enter shows the description and metadata
- [ ] agent view, alpha's transcript: its finding calls drawn the same way as in the main chat
- [ ] persistence: quit, restart with `--continue`, call list_findings: the same findings are listed, and a new add_finding gets the next id
EOF
}

credentials_prompt() {
  cat <<'EOF'
This is a manual test of subagent credentials. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either. These are fake test secrets, not real ones. Tell every subagent to quote each tool result verbatim in its final answer. After each step, quote your own tool results verbatim before going on.

1. In ONE `subagent` call with `background: true`, start these three `worker` subagents in parallel (only two run at once, so charlie should start queued):
   - name "alpha", task: Do not edit files. Call add_credential with label "GitHub CI Token!", purpose "push to the CI repo", value "ghp_fake_alpha". Then run `sleep 20` with bash. Then call list_credentials. Finish with every tool result and every <agent_credentials> notice you received, quoted verbatim.
   - name "bravo", task: Do not edit files. Run `sleep 8` with bash first, then call add_credential with label "npm-token", purpose "publish the package", value "npm_fake_bravo". Then call get_credential for alpha's credential id. Finish with every tool result and every <agent_credentials> notice you received, quoted verbatim.
   - name "charlie", task: Do not edit files. First quote any <agent_credentials> notice you already received (one should have been held while you were queued). Then run `sleep 5` with bash. Finish with every tool result and every notice you received, quoted verbatim.
2. Call subagent_wait with no names. A credential announcement may end the wait early: quote the heading, call get_credential for each id it names, then call subagent_wait again, until all three have finished.
3. Call add_credential yourself with label "orchestrator-key", purpose "sign releases", value "sk_fake_orch".
4. Call list_credentials, then get_credential for every id.
5. Read every result with subagent_result.
6. Give a checklist, each item marked worked or failed with the evidence:
   - ids are integers counting up from 1 across all subagents and the orchestrator
   - alpha's credential reached you as an <agent_credentials> notice with its value, and ended subagent_wait early
   - alpha's credential also reached bravo and charlie (quoted in their results)
   - charlie, queued when alpha added its credential, received the announcement when it started
   - alpha's label "GitHub CI Token!" was stored normalized as "github-ci-token"
   - bravo could get_credential alpha's credential and see its value
   - the credential you added (step 3) was NOT announced back to you, but a running subagent would receive it
   - list_credentials shows every credential without values; get_credential shows the values
   - each subagent_result ends with a summary of that subagent's credentials (id, label)
7. Finally, print this checklist verbatim for the human tester:

- [ ] main chat: each credential announcement is one line, `⚷ #N <label> · <sender> · <purpose>`
- [ ] main chat: add_credential / get_credential / list_credentials calls are drawn as compact `●` lines, not text blocks
- [ ] main chat: expanding an announcement or a credential tool result shows the credential as JSON, value included
- [ ] dock: alpha's row shows a ⚷ badge with its count
- [ ] agent view, Credentials tab (→ three times from Agents): every credential listed with label, sender, and purpose; Enter shows the value
- [ ] persistence: quit, restart with `--continue`, call list_credentials: the same credentials are listed, and a new add_credential gets the next id
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

SCENARIO="$1"
shift

case "$SCENARIO" in
  chat)
    PROMPT="$(chat_prompt)"
    ;;
  skills)
    PROMPT="$(skills_prompt)"
    ;;
  control)
    PROMPT="$(control_prompt)"
    ;;
  render)
    PROMPT="$(render_prompt)"
    ;;
  visibility)
    PROMPT="$(visibility_prompt)"
    ;;
  findings)
    PROMPT="$(findings_prompt)"
    ;;
  credentials)
    PROMPT="$(credentials_prompt)"
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown scenario: $SCENARIO"
    echo
    usage
    exit 1
    ;;
esac

# Rebuild only what changed since the last build. The bundle is written last, so its age stands for the whole build.
# coding-agent depends on the other packages' dist, so a change in any of them needs the full build. build:offline skips
# refetching the model catalog, which would change the generated model data.
BUNDLE="$SCRIPT_DIR/packages/coding-agent/dist/bundle/cli.js"
DEPENDENCIES=(telemetry chord tui codemode mcp ai durable env agent)
newer_sources() {
  local dirs=()
  for pkg in "$@"; do dirs+=("$SCRIPT_DIR/packages/$pkg/src"); done
  [[ -n "$(find "${dirs[@]}" -type f -newer "$BUNDLE" -print -quit)" ]]
}
if [[ ! -f "$BUNDLE" ]] || newer_sources "${DEPENDENCIES[@]}"; then
  echo "Building all packages..."
  (cd "$SCRIPT_DIR" && npm run build:offline)
elif newer_sources coding-agent; then
  echo "Building coding-agent..."
  (cd "$SCRIPT_DIR" && npm run build -w packages/coding-agent)
fi

# Write every model request of the orchestrator and its subagents to a fresh directory per run, unless set already.
export PIBER_DEBUG="${PIBER_DEBUG:-/tmp/piber-debug/$SCENARIO-$(date +%Y%m%d-%H%M%S)}"
echo "Model requests: $PIBER_DEBUG"

exec "$SCRIPT_DIR/pi-test.sh" --built "$@" "$PROMPT"
