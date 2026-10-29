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
  echo "  chat    Subagent chat: subagent to subagent, reply waits, orchestrator replies, held messages, broadcast"
  echo "  skills  Skill search: listing, query and tag ranking, no match, load_skill, tool gating, extraSkillGroups"
  echo "  control Subagent control: start now, pause, resume, terminate, handback, held chat for paused subagents"
}

chat_prompt() {
  cat <<'EOF'
This is a manual test of the subagent chat feature. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either.

1. In ONE `subagent` call with `background: true`, start these three `worker` subagents in parallel (only two run at once, so charlie should start queued):
   - name "alpha", task: Do not edit files. Run `grep -rn "class ChatHub" packages/coding-agent/src`. Send the file and line to the orchestrator with chat_send and waitForReply: true, asking "Found ChatHub. Should I also look for ChatClient?". If the answer is yes, find ChatClient the same way. Answer any message that is waiting for your reply. If your wait ends before the orchestrator answers, ask it again with waitForReply. Do not finish until you have the orchestrator's answer. Finish with what you found and every chat message you received, with its sender.
   - name "bravo", task: Do not edit files. Ask alpha with chat_send and waitForReply: true: "Which file defines ChatHub?". After the reply, run `grep -rn "class ChatBubble" packages/coding-agent/src` and send the result to alpha without waiting. Finish with the reply you got and every chat message you received, with its sender.
   - name "charlie", task: Do not edit files. First list the chat messages you have already received. Then send "charlie is running" to "all". Finish with every chat message you received, with its sender.
2. Right after that call returns, send charlie, without waiting: "Held message: you were queued when this was sent." Then call chat_peers.
3. Call subagent_wait with no names. A chat message to you ends the wait early; answer it, then call subagent_wait again to keep waiting, until all three have finished.
4. When alpha asks its question, answer "yes" with chat_send to alpha. Answer any other message that is waiting for your reply with a short acknowledgement.
5. Once all three have finished, read their results with subagent_result. Then give a checklist of chat paths, each marked worked or failed with the evidence:
   - subagent to subagent (bravo to alpha, without waiting)
   - subagent to subagent with waitForReply (bravo asks alpha)
   - subagent to orchestrator with waitForReply (alpha asks you)
   - orchestrator to subagent (your reply to alpha)
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
     Also quote the "Skills" section of your system prompt verbatim.
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
   - rex prompt: Skills section lists the tags and the pinned skill review-checklist
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

exec "$SCRIPT_DIR/pi-test.sh" --built "$@" "$PROMPT"
