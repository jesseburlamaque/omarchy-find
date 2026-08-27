#!/usr/bin/env node
// Plain-Node unit tests for the pure logic in ai/AiConfig.js, ai/AiAdapters.js
// and ai/AiBackend.js.
//
// These files are QML "pragma library" JavaScript, not CommonJS/ESM, so they
// use two Qt-specific directives Node doesn't understand:
//   .pragma library
//   .import "Other.js" as Other
//
// loadQmlLibrary() below strips those two directive lines and runs the rest
// of the file's source in a fresh vm context. Because top-level `var`/
// `function` declarations in script-mode vm code become properties of the
// context object, the resulting context *is* the same member surface QML
// would see through the `as Other` import alias — so this loader is a
// faithful (if minimal) stand-in for Quickshell's JS import mechanics, and
// the modules under test are otherwise completely unmodified production
// source: no test-only fork, no logic duplicated into this file.
//
// Run with: node tests/ai_unit_test.js

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const AI_DIR = path.join(__dirname, "..", "ai")

function loadQmlLibrary(fileName, deps) {
  const filePath = path.join(AI_DIR, fileName)
  const raw = fs.readFileSync(filePath, "utf8")
  const stripped = raw
    .split("\n")
    .filter(line => {
      const t = line.trim()
      return !(t === ".pragma library" || t.indexOf(".import ") === 0)
    })
    .join("\n")

  const sandbox = Object.assign({ console: console }, deps || {})
  vm.createContext(sandbox)
  vm.runInContext(stripped, sandbox, { filename: fileName })
  return sandbox
}

const AiConfig = loadQmlLibrary("AiConfig.js")
const AiAdapters = loadQmlLibrary("AiAdapters.js")
const AiBackend = loadQmlLibrary("AiBackend.js", { AiConfig: AiConfig, AiAdapters: AiAdapters })

// ---------------------------------------------------------------- harness --

let pass = 0
let fail = 0
const failures = []

function assert(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(msg)
    console.error("FAIL: " + msg)
  }
}

function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  assert(ok, msg + " (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")")
}

// ------------------------------------------------------------ AiConfig ----

{
  const r = AiConfig.mergeConfig(null)
  eq(r.config, AiConfig.DEFAULT_CONFIG, "mergeConfig(null) returns compiled defaults")
  assert(r.warning === null, "mergeConfig(null) has no warning")
}

{
  const r = AiConfig.mergeConfig("")
  eq(r.config, AiConfig.DEFAULT_CONFIG, "mergeConfig('') returns compiled defaults")
}

{
  const r = AiConfig.mergeConfig("{ not json")
  eq(r.config, AiConfig.DEFAULT_CONFIG, "invalid JSON falls back to defaults")
  assert(typeof r.warning === "string" && r.warning.length > 0, "invalid JSON produces a warning")
}

{
  const r = AiConfig.mergeConfig("[1,2,3]")
  eq(r.config, AiConfig.DEFAULT_CONFIG, "non-object JSON falls back to defaults")
  assert(typeof r.warning === "string", "non-object JSON produces a warning")
}

{
  const r = AiConfig.mergeConfig(JSON.stringify({ agent: "codex", model: "gpt-5-codex", maxAnswerRows: 10 }))
  eq(r.config.agent, "codex", "valid agent override applied")
  eq(r.config.model, "gpt-5-codex", "valid model override applied")
  eq(r.config.maxAnswerRows, 10, "valid maxAnswerRows override applied")
  eq(r.config.prefix, "ai ", "unset fields keep their default (prefix)")
  assert(r.warning === null, "fully valid overrides produce no warning")
}

{
  const r = AiConfig.mergeConfig(JSON.stringify({ maxAnswerRows: -50 }))
  eq(r.config.maxAnswerRows, AiConfig.DEFAULT_CONFIG.maxAnswerRows, "invalid maxAnswerRows falls back to default")
  assert(typeof r.warning === "string" && r.warning.indexOf("maxAnswerRows") !== -1, "invalid field named in warning")
}

{
  const r = AiConfig.mergeConfig(JSON.stringify({ agent: "chatgpt-plugin-xyz" }))
  eq(r.config.agent, "claude", "unsupported agent falls back to default agent")
}

{
  const r = AiConfig.mergeConfig(JSON.stringify({ totallyUnknownField: 123, agent: "agy" }))
  eq(r.config.agent, "agy", "known field still applied alongside unknown field")
  assert(r.config.totallyUnknownField === undefined, "unknown field is not copied into runtime config")
  assert(r.warning === null, "unknown fields alone produce no warning")
}

{
  const r = AiConfig.mergeConfig(JSON.stringify({ model: null }))
  eq(r.config.model, null, "explicit null model is accepted (means: no override)")
  assert(r.warning === null, "explicit null model produces no warning")
}

// --------------------------------------------------------- AiAdapters -----

{
  const id = AiAdapters.uuidv4()
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    "uuidv4 produces a well-formed RFC4122 v4 id: " + id)
  assert(AiAdapters.uuidv4() !== AiAdapters.uuidv4(), "uuidv4 is not constant across calls")
}

// argv safety: prompt must always be a single literal argv element, never
// concatenated into another string, for every adapter.
for (const id of ["claude", "codex", "agy"]) {
  const adapter = AiAdapters.get(id)
  assert(adapter !== null, "adapter registered: " + id)
  const nasty = "\"'; $(echo hi) `uname` | ; \n中文 🚀"
  const sessionRef = adapter.capabilities.continuity === "caller-id" ? adapter.createSessionRef() : null
  const argv = adapter.buildRun(nasty, sessionRef, AiConfig.defaults())
  assert(Array.isArray(argv), id + ".buildRun returns an array")
  assert(argv.indexOf(nasty) !== -1, id + ".buildRun keeps the prompt as one literal argv element")
  for (const part of argv) assert(typeof part === "string", id + ".buildRun argv elements are all strings")
}

{
  // Claude: NDJSON captured from a real `claude -p ... --include-partial-messages` run.
  const adapter = AiAdapters.get("claude")
  const ps = {}
  const lines = [
    '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc-123","tools":[]}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" world"}}}',
    '{"type":"result","is_error":false,"result":"Hello world","session_id":"abc-123"}'
  ]
  let text = ""
  let sawSession = null
  for (const line of lines) {
    for (const ev of adapter.parseLine(line, ps)) {
      if (ev.type === "text") text += ev.text
      if (ev.type === "session") sawSession = ev.sessionRef
    }
  }
  eq(text, "Hello world", "claude adapter reconstructs streamed text from real event shapes")
  eq(sawSession, "abc-123", "claude adapter captures session_id")
  eq(ps.finalText, "Hello world", "claude adapter stashes result text as a fallback")
}

{
  // Claude: tool_use content block for WebSearch should raise the searching activity.
  const adapter = AiAdapters.get("claude")
  const ps = {}
  const events = adapter.parseLine(
    '{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","name":"WebSearch","input":{}}}}', ps)
  assert(events.some(e => e.type === "tool" && e.tool === "web_search"), "claude web_search tool_use recognized")
  assert(events.some(e => e.type === "activity" && e.activity === "searching"), "claude web_search sets searching activity")
}

{
  // Codex: NDJSON captured from a real `codex exec --json` run (quota-failure
  // path) plus a synthesized success path cross-checked against the
  // takopi.dev exec-json field reference.
  const adapter = AiAdapters.get("codex")
  const ps = {}
  let sawSession = null
  for (const ev of adapter.parseLine('{"type":"thread.started","thread_id":"01a04225-1069-7080-9804-727fdd326f7e"}', ps)) {
    if (ev.type === "session") sawSession = ev.sessionRef
  }
  eq(sawSession, "01a04225-1069-7080-9804-727fdd326f7e", "codex adapter captures thread_id as sessionRef")

  let text = ""
  const itemLines = [
    '{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"Hel"}}',
    '{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"Hello wor"}}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello world"}}'
  ]
  for (const line of itemLines) {
    for (const ev of adapter.parseLine(line, ps)) if (ev.type === "text") text += ev.text
  }
  eq(text, "Hello world", "codex adapter computes incremental deltas across item.updated/completed without duplication")

  const failEvents = adapter.parseLine(
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}', ps)
  assert(failEvents.some(e => e.type === "error" && e.message.indexOf("usage limit") !== -1),
    "codex turn.failed surfaces the real error message (matches live probe)")
}

{
  const adapter = AiAdapters.get("codex")
  const cls = adapter.classifyFailure(1, "You've hit your usage limit. Upgrade to Pro")
  assert(cls && cls.kind === "quota", "codex classifyFailure recognizes the real quota-exhaustion stderr")
}

{
  // Antigravity: argv order and event schema below are both verified
  // against a real successful `agy --conversation <uuid> --print '<prompt>'
  // --output-format stream-json` run (the task's originally-specified flag
  // order is broken — --print/--prompt is value-taking, not boolean, so it
  // swallows the next token as the prompt; see AiAdapters.js buildRun).
  const adapter = AiAdapters.get("agy")

  const argv = adapter.buildRun("hello", "caller-uuid", AiConfig.defaults())
  const printIdx = argv.indexOf("--print")
  eq(argv[printIdx + 1], "hello", "agy buildRun binds the prompt as --print's own value, not a trailing positional")
  assert(argv.indexOf("--conversation") < printIdx, "agy buildRun places --conversation before --print")

  const ps = {}
  let text = ""
  let sawSession = null
  const lines = [
    '{"event":"init","conversation_id":"real-id-456","init":{"cwd":"/tmp","tools":[]}}',
    '{"event":"step_update","step_update":{"conversation_id":"real-id-456","step_index":0,"state":"DONE","step_type":"user_input"}}',
    '{"event":"step_update","step_update":{"conversation_id":"real-id-456","step_index":1,"state":"DONE","step_type":"checkpoint","duration_seconds":1.64}}',
    '{"event":"step_update","step_update":{"conversation_id":"real-id-456","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
    '{"event":"step_update","step_update":{"conversation_id":"real-id-456","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n"}}',
    '{"event":"result","result":{"conversation_id":"real-id-456","status":"SUCCESS","response":"OK\\n"}}'
  ]
  for (const line of lines) {
    for (const ev of adapter.parseLine(line, ps)) {
      if (ev.type === "text") text += ev.text
      if (ev.type === "session") sawSession = ev.sessionRef
    }
  }
  eq(sawSession, "real-id-456", "agy adapter takes conversation_id from the init event as authoritative")
  eq(text, "OK\n", "agy adapter reconstructs streamed text from real step_update.agent_response.text_delta events")
  eq(ps.finalText, "OK\n", "agy adapter stashes the result.response text as a fallback")

  const cls = adapter.classifyFailure(0,
    'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.')
  assert(cls && cls.kind === "permission", "agy classifyFailure recognizes the real headless permission-wall stderr")
}

{
  // Malformed JSON / unknown event types must never throw for any adapter.
  for (const id of ["claude", "codex", "agy"]) {
    const adapter = AiAdapters.get(id)
    let threw = false
    try {
      adapter.parseLine("not json at all {{{", {})
      adapter.parseLine('{"type":"some_totally_unknown_future_event","foo":"bar"}', {})
      adapter.parseLine("", {})
      adapter.parseLine(undefined, {})
    } catch (e) {
      threw = true
    }
    assert(!threw, id + ".parseLine never throws on malformed/unknown/empty input")
  }
}

// ---------------------------------------------------------- AiBackend -----

{
  eq(AiBackend.matchPrefix("ai explain io_uring", "ai "), "explain io_uring", "matchPrefix extracts the prompt after the default prefix")
  eq(AiBackend.matchPrefix("AI Explain X", "ai "), "Explain X", "matchPrefix is case-insensitive")
  eq(AiBackend.matchPrefix("  ai   explain X", "ai "), "explain X", "matchPrefix tolerates leading/extra whitespace")
  eq(AiBackend.matchPrefix("ai", "ai "), null, "matchPrefix requires text after the prefix (bare prefix isn't AI mode yet)")
  eq(AiBackend.matchPrefix("aiexplain", "ai "), null, "matchPrefix does not match a prefix glued to the next word")
  eq(AiBackend.matchPrefix("go something", "ai "), null, "matchPrefix does not match an unrelated prefix")
  eq(AiBackend.matchPrefix("ask something", "ask "), "something", "matchPrefix honors a configured custom prefix")
}

{
  AiBackend.loadConfig(JSON.stringify({ agent: "claude" }))
  const disp = AiBackend.agentDisplay()
  eq(disp, { agentId: "claude", agentLabel: "Claude", binary: "claude", modelLabel: null, supported: true },
    "agentDisplay reflects loaded config before any generation starts")
}

{
  AiBackend.loadConfig(null)
  const g1 = AiBackend.beginGeneration("first prompt")
  assert(g1.generation === 1 || g1.generation > 0, "beginGeneration returns a positive generation id")
  assert(Array.isArray(g1.argv) && g1.argv[0] === "setsid", "spawned argv is wrapped with setsid for group isolation")
  assert(g1.argv.indexOf("first prompt") !== -1, "prompt reaches argv as one literal element, unwrapped")

  const genA = g1.generation
  let snap = AiBackend.handleLine(genA, '{"type":"system","subtype":"init","session_id":"sess-a","cwd":"/"}')
  eq(snap.state, "running", "state advances to running on first parsed event")
  eq(snap.sessionRef, "sess-a", "session ref captured mid-stream")

  // Cancel generation A, then immediately start generation B (race test,
  // plan §26.4): late events tagged with A's generation must never mutate
  // B's session.
  AiBackend.cancel()
  const g2 = AiBackend.beginGeneration("second prompt")
  const genB = g2.generation
  assert(genB > genA, "generation counter is monotonically increasing")

  const staleResult = AiBackend.handleLine(genA, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"LEAKED FROM A"}}}')
  assert(staleResult === null, "late event tagged with the old generation is rejected outright")

  const bSnap = AiBackend.handleLine(genB, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"real B text"}}}')
  assert(bSnap.rawText.indexOf("LEAKED FROM A") === -1, "B's rawText never contains A's leaked text")
  eq(bSnap.rawText, "real B text", "B's rawText only contains B's own text")

  const staleExit = AiBackend.handleExit(genA, 0)
  assert(staleExit === null, "late process-exit from the old generation cannot move B to Ready")
  eq(AiBackend.snapshot().state, "running", "B's state is unaffected by A's stale exit callback")
}

// P0-1 regression test — QA finding: the test above only proves AiBackend's
// OWN generation guard (isStale) works when handed the correct old gen id
// directly. It can never catch the REAL bug, which lives one layer up: a
// naive Find.qml ping-pong that reassigns a Process's `.gen`/command/running
// while that Process's PREVIOUS OS incarnation is still alive. Verified
// Quickshell fact (quickshell/src/io/process.cpp): `running` stays true
// until the OS process genuinely exits, even after running=false requests
// termination — so blindly ping-ponging can silently overwrite `.gen` on a
// slot whose old process hasn't died yet; when it FINALLY does die, its
// last stdout flush and exit event read the ALREADY-OVERWRITTEN `.gen` and
// get misattributed to the new generation (spec §26.4 — worst case, Enter
// then resumes the WRONG conversation).
//
// This test simulates Find.qml's actual dispatch logic — using the real,
// exported AiBackend.pickFreeSlot oracle Find.qml calls before ever
// touching a Process — against a mock of the two slots that faithfully
// reproduces the verified Quickshell fact above (cancelling does NOT make
// `running` false; only a real "process exit" does). It reproduces the
// exact QA-specified trigger: submit(gen1->A) -> cancel -> submit(gen2->B)
// -> cancel -> submit(gen3) while gen1's CLI is still dying.
{
  function makeMockSlot() { return { running: false, gen: 0, command: null } }

  // Mirrors Find.qml's aiDispatchOrQueue(): the ONLY correct way to hand a
  // generation to a slot — must go through pickFreeSlot, must queue instead
  // of touching a busy slot.
  function mockDispatch(slots, pendingBox, generation, argv) {
    var slot = AiBackend.pickFreeSlot(slots.A.running, slots.B.running)
    if (slot === null) { pendingBox.value = { generation: generation, argv: argv }; return }
    pendingBox.value = null
    var proc = slots[slot]
    proc.gen = generation
    proc.command = argv
    proc.running = true
  }

  // Mirrors Find.qml's aiTryDispatchPending(), called once a slot is
  // verified free (a real exit just happened).
  function mockTryDispatchPending(slots, pendingBox) {
    if (!pendingBox.value) return
    var slot = AiBackend.pickFreeSlot(slots.A.running, slots.B.running)
    if (slot === null) return
    var pending = pendingBox.value
    pendingBox.value = null
    var proc = slots[slot]
    proc.gen = pending.generation
    proc.command = pending.argv
    proc.running = true
  }

  AiBackend.loadConfig(JSON.stringify({ agent: "claude" }))
  AiBackend.cancel()

  var slots = { A: makeMockSlot(), B: makeMockSlot() }
  var pendingBox = { value: null }

  // submit gen1 -> dispatched onto A (both slots free, A wins ties)
  var g1 = AiBackend.beginGeneration("first")
  mockDispatch(slots, pendingBox, g1.generation, g1.argv)
  eq(slots.A.gen, g1.generation, "gen1 dispatched onto slot A")
  assert(slots.A.running === true, "slot A is running gen1")

  // cancel — per the verified Quickshell fact, this does NOT make A stop
  // running; the mock deliberately leaves slots.A.running === true, exactly
  // like the real Process would.
  AiBackend.cancel()

  // submit gen2 -> A is still busy (still "dying"), so gen2 must land on B.
  var g2 = AiBackend.beginGeneration("second")
  mockDispatch(slots, pendingBox, g2.generation, g2.argv)
  eq(slots.B.gen, g2.generation, "gen2 dispatched onto slot B because A is still busy")
  assert(pendingBox.value === null, "no queueing needed yet — B was free")

  // cancel again — B doesn't stop running either, for the same reason.
  AiBackend.cancel()

  // submit gen3 -> BOTH slots are still "dying". The critical assertion:
  // slot A's `.gen` must NOT be touched while A is still alive. A naive
  // ping-pong (A, B, A, B, ... with no busy-check) would overwrite
  // slots.A.gen to gen3 right here — this is exactly the bug.
  var g3 = AiBackend.beginGeneration("third")
  mockDispatch(slots, pendingBox, g3.generation, g3.argv)
  assert(pendingBox.value !== null && pendingBox.value.generation === g3.generation,
    "gen3 is queued instead of dispatched, because both slots are still busy")
  eq(slots.A.gen, g1.generation,
    "slot A's .gen is untouched while A is still dying — this is the actual P0-1 fix; a naive ping-pong would fail this assertion")

  // Now gen1's real OS process actually dies. Its stdout parser flushes a
  // remainder line and `exited` fires — Find.qml would read slots.A.gen at
  // that moment, which is STILL g1 (never overwritten), so both correctly
  // resolve against gen1, not gen3.
  const leakedLine = AiBackend.handleLine(slots.A.gen,
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"LEAKED FROM GEN1"}}}')
  assert(leakedLine === null, "gen1's late stdout is rejected by AiBackend (gen1 was already cancelled) — never reaches gen3's session")

  const exitSnap = AiBackend.handleExit(slots.A.gen, 0)
  assert(exitSnap === null, "gen1's late exit is rejected by AiBackend — cannot wrongly promote gen3 to Ready using gen1's data")
  slots.A.running = false // the OS process is now genuinely gone
  mockTryDispatchPending(slots, pendingBox)

  // Slot A is now verified free, so the queued gen3 is dispatched onto it
  // as a genuinely FRESH start (not a latched deferred one).
  eq(slots.A.gen, g3.generation, "queued gen3 is dispatched onto slot A only once A is verified free (running === false)")
  assert(slots.A.running === true, "slot A is now running gen3")
  assert(pendingBox.value === null, "the queue is drained")

  // Finally: gen3's own session must contain only its own text/identity —
  // no leakage from gen1 despite reusing the same Process slot.
  const g3Snap = AiBackend.handleLine(slots.A.gen,
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"real gen3 text"}}}')
  eq(g3Snap.rawText, "real gen3 text", "gen3's rawText contains only its own text — no leakage from gen1 despite slot reuse")
  eq(g3Snap.generation, g3.generation, "the session AiBackend is tracking is genuinely gen3, not a contaminated gen1/gen3 mix")

  // pickFreeSlot itself, directly: the decision oracle Find.qml relies on.
  eq(AiBackend.pickFreeSlot(true, true), null, "pickFreeSlot: both busy -> must queue, never pick a busy slot")
  eq(AiBackend.pickFreeSlot(true, false), "B", "pickFreeSlot: only B free -> B")
  eq(AiBackend.pickFreeSlot(false, true), "A", "pickFreeSlot: only A free -> A")
  eq(AiBackend.pickFreeSlot(false, false), "A", "pickFreeSlot: both free -> A (deterministic tie-break)")
}

{
  // Full run-to-Ready + drain behavior, including raw/displayed separation.
  AiBackend.loadConfig(JSON.stringify({ streamFlushMs: 16, drainBaseCps: 1 })) // near-zero floor so pendingText survives many ticks
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("drain test")
  const gen = g.generation
  AiBackend.handleLine(gen, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AB"}}}')
  let snap = AiBackend.snapshot()
  eq(snap.displayedText, "AB", "first chunk (2 chars) is flushed immediately regardless of drain rate")

  const bigChunk = "C".repeat(500)
  AiBackend.handleLine(gen, JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: bigChunk } } }))
  snap = AiBackend.snapshot()
  assert(snap.rawText.length === 2 + 500, "rawText accumulates the full backlog immediately")
  assert(snap.displayedText.length < snap.rawText.length, "displayedText lags rawText while backlog is pending (raw/displayed separation, plan §16)")

  let ticks = 0
  while (AiBackend.snapshot().pendingText.length > 0 && ticks < 100000) {
    AiBackend.tick()
    ticks++
  }
  assert(ticks > 1, "draining a large backlog takes more than one tick (the smooth catch-up law, not an unbounded single-tick dump — plan §17)")
  eq(AiBackend.snapshot().displayedText, AiBackend.snapshot().rawText, "once fully drained, displayedText exactly equals rawText")

  // pendingText is already 0 here, so handleExit()'s own return already
  // reflects the settled state (finishDraining() runs synchronously inside
  // it) — tick() would now correctly return null on a no-op call, so use
  // handleExit()'s return directly rather than calling tick() again.
  const finalSnap = AiBackend.handleExit(gen, 0)
  eq(finalSnap.state, "ready", "state reaches ready once process exited and backlog fully drained")
  assert(finalSnap.canHandoff === false, "canHandoff stays false when no sessionRef was ever captured (no faked continuity)")
}

{
  // Agy-style caller-id continuity + handoff argv, including the
  // conversation_id override gotcha end to end.
  AiBackend.loadConfig(JSON.stringify({ agent: "agy" }))
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("zebra test")
  const gen = g.generation
  const callerUuid = g.argv[g.argv.indexOf("--conversation") + 1]
  assert(/^[0-9a-f-]{36}$/i.test(callerUuid), "agy generation pre-seeds a caller UUID into argv")

  AiBackend.handleLine(gen, JSON.stringify({ event: "init", conversation_id: "server-assigned-id" }))
  AiBackend.handleLine(gen, JSON.stringify({ event: "step_update", step_update: { conversation_id: "server-assigned-id", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ZEBRA" } }))
  // "ZEBRA" is short enough to land entirely via the first-chunk immediate
  // flush, so pendingText is already 0 by the time the process exits —
  // handleExit()'s own return (finishDraining() runs synchronously inside
  // it) already reflects Ready; tick() would correctly no-op (return null).
  const snap = AiBackend.handleExit(gen, 0)
  eq(snap.sessionRef, "server-assigned-id", "server-reported conversation_id overrides the caller-supplied uuid")
  assert(snap.sessionRef !== callerUuid, "handoff never uses the caller uuid when the server reported a different id")

  const resumeArgv = AiBackend.buildHandoffArgv()
  assert(resumeArgv.indexOf("server-assigned-id") !== -1, "handoff argv resumes the server-confirmed id, not the caller guess")
  assert(resumeArgv.indexOf(callerUuid) === -1, "handoff argv never references the stale caller uuid")
}

{
  // Unsupported agent in config must produce a clear, non-crashing error and
  // never a fake/guessed handoff.
  AiBackend.loadConfig(JSON.stringify({ model: null }))
  // Bypass validation to simulate a config file that predates a removed
  // agent, or a future config with a still-unknown id after validation.
  AiBackend.getConfig().agent = "some-future-cli"
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("test")
  assert(g.argv === null, "unsupported agent never produces a spawn argv")
  const snap = AiBackend.snapshot()
  eq(snap.state, "error", "unsupported agent lands directly in error state")
  assert(snap.canHandoff === false, "unsupported agent never allows handoff")
}

{
  // Antigravity's real observed failure mode: exit code 0, zero stdout
  // lines, permission-wall stderr. Must still land in Error, not silently
  // look like an empty success.
  AiBackend.loadConfig(JSON.stringify({ agent: "agy" }))
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("zero output test")
  const gen = g.generation
  AiBackend.handleStderrChunk(gen,
    'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n')
  const snap = AiBackend.handleExit(gen, 0)
  eq(snap.state, "error", "zero-stdout + exit-0 is still classified as a failure, never a silent empty success")
  eq(snap.errorKind, "permission", "the real agy permission-wall stderr is classified correctly end to end")
}

{
  // P0-3: Handoff state prevents a second Enter (or key auto-repeat) from
  // dispatching a second terminal onto the same session.
  AiBackend.loadConfig(JSON.stringify({ agent: "claude" }))
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("handoff test")
  AiBackend.handleLine(g.generation, '{"type":"system","subtype":"init","session_id":"handoff-sess","cwd":"/"}')
  AiBackend.handleLine(g.generation, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}')
  // "hello" lands via the first-chunk flush, so pendingText is already 0 at
  // exit — use handleExit()'s own return (see the agy test above for why).
  let snap = AiBackend.handleExit(g.generation, 0)
  eq(snap.state, "ready", "reaches ready before testing handoff")

  const resumeArgv1 = AiBackend.buildHandoffArgv()
  assert(Array.isArray(resumeArgv1), "buildHandoffArgv works from Ready")

  const handoffSnap = AiBackend.beginHandoff()
  assert(handoffSnap !== null, "beginHandoff succeeds from Ready")
  eq(handoffSnap.state, "handoff", "state transitions to handoff")

  const secondHandoff = AiBackend.beginHandoff()
  assert(secondHandoff === null, "a second beginHandoff() call while already in Handoff state is rejected — this is what stops a duplicate terminal spawn (QA P0-3)")
  eq(AiBackend.snapshot().state, "handoff", "state is unchanged by the rejected second call")

  // A failed launch should let the user retry via Enter again.
  const backToReady = AiBackend.cancelHandoff()
  assert(backToReady !== null, "cancelHandoff succeeds from Handoff")
  eq(backToReady.state, "ready", "cancelHandoff returns the session to Ready so Enter can be tried again")

  const cancelWhenNotHandoff = AiBackend.cancelHandoff()
  assert(cancelWhenNotHandoff === null, "cancelHandoff is a no-op (returns null) when not actually in Handoff state")
}

{
  // Draining hard bound (plan §17, QA P0-7/round-4 rewrite): once the
  // process exits, even a very large backlog must reach Ready within
  // DRAIN_MAX_MS (~300ms) of real time — a 20-second "thinking…" dead zone
  // after the process already exited was the original bug. The reveal law
  // itself changed (single smooth exponential catch-up, not the old two-
  // regime normal+boost formula), but the hard completion bound is the same
  // requirement, now expressed as ticks-derived-from-ms so it stays correct
  // at whatever streamFlushMs is actually configured.
  const streamFlushMs = 16 // real default (60Hz)
  AiBackend.loadConfig(JSON.stringify({ streamFlushMs: streamFlushMs, drainBaseCps: 60 }))
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("big drain test")
  const bigChunk = "X".repeat(8000)
  AiBackend.handleLine(g.generation, JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: bigChunk } } }))
  AiBackend.handleExit(g.generation, 0) // -> Draining, 8000-char backlog pending

  let ticks = 0
  let snap
  do {
    snap = AiBackend.tick()
    ticks++
  } while (snap.state === "draining" && ticks < 1000)

  eq(snap.state, "ready", "an 8000-char backlog still reaches Ready (drain always completes)")
  eq(snap.displayedText, snap.rawText, "fully drained: displayedText exactly equals rawText — item 7(c)")
  // Mirrors AiBackend's own maxTicks derivation (DRAIN_MAX_MS / tick
  // interval) rather than a hardcoded number, so this stays a bound check —
  // not a brittle exact-count assertion — if either constant is retuned.
  const DRAIN_MAX_MS = 300
  const maxTicks = Math.ceil(DRAIN_MAX_MS / streamFlushMs)
  assert(ticks <= maxTicks, "an 8000-char backlog drains within the ~300ms hard bound (" + ticks + " <= " + maxTicks + " ticks at " + streamFlushMs + "ms/tick) — item 7(c)")
  // maxTicks itself is a ceil() of 300/streamFlushMs, so the wall-clock
  // equivalent can legitimately land up to one tick's worth over the
  // nominal 300ms target (19 ticks * 16ms = 304ms here) — that's the
  // "~300ms" tolerance, not a bug in the bound.
  assert((ticks * streamFlushMs) <= 300 + streamFlushMs, "wall-clock equivalent of the drain stays within ~300ms, +1 tick of ceil() slack (" + (ticks * streamFlushMs) + "ms)")
}

{
  // Smoothness regression test (rewritten after live-overlay feedback: the
  // old 20Hz two-regime formula was visibly chunky/bursty — lag built up
  // then dumped once the bounded "boost" kicked in). Replays the REAL
  // chunk boundaries captured from a live `claude -p ... --include-partial-
  // messages` run (fixtures/claude_zebra_qa2_1.out from the QA scratchpad —
  // genuine model output, split at the actual text_delta event
  // boundaries the CLI emitted) through a full simulated 16ms-tick timeline
  // of handleLine()+tick(). Exact wall-clock inter-arrival gaps weren't
  // recorded by the raw capture (only event content was saved), so a
  // deterministic, plausible synthetic arrival schedule is used — noted
  // explicitly rather than claimed as literally recorded — including one
  // deliberately injected burst (three real chunks landing on the same
  // tick) to specifically exercise the "fast generation, uneven catch-up"
  // complaint that motivated this rewrite.
  AiBackend.loadConfig(null) // real defaults: streamFlushMs=16 (60Hz), drainBaseCps=60
  AiBackend.cancel()
  const TICK_MS = 16

  const realChunks = [
    "I'll update the existing memory with the new codename.",
    "Done — I've updated the existing memory: your project codename is now **",
    "ZEBRA-QA-ROUND-2", "** (noting it was previously ZEBRA). ",
    "This will persist across future sessions."
  ]
  // Chunk 0 lands at tick 0 (first-chunk immediate flush, <=80 chars).
  // Chunks 2,3,4 all land on tick 5 together — the injected burst.
  const arrivalTick = [0, 2, 5, 5, 5]

  const g = AiBackend.beginGeneration("zebra")
  var deliveredIdx = 0
  var arrivalTickOfChar = [] // arrivalTickOfChar[i] = simulated tick at which rawText[i] arrived
  var displayedLenPrev = 0
  var worstLagMs = 0
  var currentTick = 0
  const MAX_TICKS = 500

  function deliverDueChunks(tick) {
    while (deliveredIdx < realChunks.length && arrivalTick[deliveredIdx] <= tick) {
      const chunk = realChunks[deliveredIdx]
      AiBackend.handleLine(g.generation, JSON.stringify({
        type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }
      }))
      for (var k = 0; k < chunk.length; k++) arrivalTickOfChar.push(tick)
      deliveredIdx++
    }
  }

  while (deliveredIdx < realChunks.length && currentTick < MAX_TICKS) {
    deliverDueChunks(currentTick)
    const tickSnap = AiBackend.tick()
    const displayedLen = tickSnap ? tickSnap.displayedText.length : AiBackend.snapshot().displayedText.length
    const revealed = displayedLen - displayedLenPrev

    // (a) after the first-chunk flush (tick 0), no single tick reveals more
    // than ~40 chars — continuous/smooth, never a burst dump. This
    // includes the deliberately injected 3-chunk burst on tick 5.
    if (currentTick > 0 && revealed > 0) {
      assert(revealed <= 40, "tick " + currentTick + " revealed " + revealed + " chars in one step (>40 = a burst dump, exactly the reported bug)")
    }

    // (b) simulated display lag: how far behind (in simulated ms) the most
    // recently displayed character is relative to when its content
    // actually arrived — the direct analogue of what a viewer perceives.
    if (displayedLen > 0 && displayedLen <= arrivalTickOfChar.length) {
      const lagMs = (currentTick - arrivalTickOfChar[displayedLen - 1]) * TICK_MS
      if (lagMs > worstLagMs) worstLagMs = lagMs
    }

    displayedLenPrev = displayedLen
    currentTick++
  }
  // Drain whatever's still pending after the last real chunk arrives, same
  // lag/smoothness checks, before the process "exits" below.
  while (AiBackend.snapshot().pendingText.length > 0 && currentTick < MAX_TICKS) {
    const tickSnap = AiBackend.tick()
    const displayedLen = tickSnap.displayedText.length
    const revealed = displayedLen - displayedLenPrev
    assert(revealed <= 40, "tick " + currentTick + " revealed " + revealed + " chars in one step (>40 = a burst dump)")
    if (displayedLen > 0 && displayedLen <= arrivalTickOfChar.length) {
      const lagMs = (currentTick - arrivalTickOfChar[displayedLen - 1]) * TICK_MS
      if (lagMs > worstLagMs) worstLagMs = lagMs
    }
    displayedLenPrev = displayedLen
    currentTick++
  }

  assert(currentTick < MAX_TICKS, "streaming converges within the simulated tick budget (sanity)")
  assert(worstLagMs < 400, "simulated display lag (" + worstLagMs + "ms) stays under ~400ms while streaming — item 7(b), matches web-app-chat feel")

  // (c) Draining completes within the bound with displayedText === rawText
  // at Ready — the process "exits" here, mid-catch-up is fine (that's what
  // Draining is for), but there may already be nothing left pending since
  // the loop above drained it — either is a valid real-world timing.
  const pendingAtExit = AiBackend.snapshot().pendingText.length
  const exitSnap = AiBackend.handleExit(g.generation, 0)
  var drainTicks = 0
  var finalState = exitSnap
  while (finalState.state === "draining" && drainTicks < 100) {
    finalState = AiBackend.tick()
    drainTicks++
  }
  eq(finalState.state, "ready", "reaches Ready once fully drained — item 7(c)")
  eq(finalState.displayedText, finalState.rawText, "displayedText === rawText at Ready — item 7(c)")
  eq(finalState.rawText, realChunks.join(""), "the full real answer is reproduced byte-exact, in order")
  const maxDrainTicks = Math.ceil(300 / TICK_MS)
  assert(drainTicks <= maxDrainTicks, "any residual backlog at exit (" + pendingAtExit + " chars) still drains within the ~300ms bound")
}

{
  // Supplementary stress sanity (not fixture-based, synthetic): a large
  // sudden RUNNING-state burst (mimicking an adapter like Codex handing
  // back a big non-incremental chunk) must decay smoothly — each
  // successive tick's reveal shrinking roughly geometrically, never
  // oscillating or jumping back up — with NO artificial per-tick ceiling
  // (plan requirement: "no per-tick hard cap that causes visible stalls").
  // A big sudden burst legitimately reveals proportionally more per tick
  // than a small one; what must never happen is a discontinuous regime
  // change like the old normal+boost formula had.
  AiBackend.loadConfig(null)
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("large burst test")
  AiBackend.handleLine(g.generation, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AB"}}}') // tiny first chunk, immediate
  const burst = "Z".repeat(4000)
  AiBackend.handleLine(g.generation, JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: burst } } }))

  var lastRevealed = Infinity
  var ticks = 0
  var pending = AiBackend.snapshot().pendingText.length
  while (pending > 0 && ticks < 1000) {
    const before = AiBackend.snapshot().displayedText.length
    const snap = AiBackend.tick()
    const revealed = snap.displayedText.length - before
    // Monotonically non-increasing (a shrinking backlog under a fixed
    // fractional law can only reveal the same or less each tick) — proves
    // there's no discontinuous "boost kicks in" jump anywhere in the decay.
    assert(revealed <= lastRevealed + 1, "tick " + ticks + " revealed MORE than the previous tick (" + revealed + " > " + lastRevealed + ") — a discontinuous jump, exactly the old bug")
    lastRevealed = revealed
    pending = snap.pendingText.length
    ticks++
  }
  eq(AiBackend.snapshot().displayedText.length, 2 + 4000, "the full burst is eventually revealed, nothing lost")
  assert(ticks > 5, "a 4000-char sudden burst still takes multiple ticks to reveal — proportional, not instant (sanity)")
}

{
  // Bug found WHILE writing the P0-7 test above: an oversized FIRST chunk
  // (e.g. an adapter — Codex's item.updated/completed — that can hand back
  // its whole answer as a single "delta" the first time text is seen) would
  // skip pendingText/pacing entirely via the "first chunk renders
  // immediately" fast path, defeating burst normalization for exactly the
  // case that needs it most. Only a small capped prefix of an oversized
  // first chunk should render immediately; the rest must still be paced.
  AiBackend.loadConfig(JSON.stringify({ streamFlushMs: 50, drainBaseCps: 60 }))
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("oversized first chunk test")
  const wholeAnswerAsOneDelta = "Y".repeat(500)
  const snap = AiBackend.handleLine(g.generation, JSON.stringify({
    type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: wholeAnswerAsOneDelta } }
  }))
  assert(snap.displayedText.length < snap.rawText.length,
    "an oversized single first delta (500 chars) is NOT fully flushed to displayedText immediately — most of it is paced through pendingText")
  assert(snap.displayedText.length > 0, "a small immediate prefix still renders right away for low perceived TTFC")
  eq(snap.displayedText.length + snap.pendingText.length, snap.rawText.length, "no characters are lost between displayedText and pendingText")
}

{
  // P1-8: the config used to build the resume argv (and shown as the chip's
  // modelLabel) must be the one frozen at submit time, not whatever ai.json
  // says by the time Enter/handoff happens.
  AiBackend.loadConfig(JSON.stringify({ agent: "claude", model: "opus" }))
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("config snapshot test")
  AiBackend.handleLine(g.generation, '{"type":"system","subtype":"init","session_id":"snap-sess","cwd":"/"}')
  AiBackend.handleLine(g.generation, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}')
  // "hi" lands via the first-chunk flush, so pendingText is already 0 at
  // exit — use handleExit()'s own return (see the agy/handoff tests above).
  let snap = AiBackend.handleExit(g.generation, 0)
  eq(snap.modelLabel, "opus", "chip modelLabel reflects the config the session actually ran with")

  // ai.json changes mid-run (or between runs, before resume is clicked).
  AiBackend.loadConfig(JSON.stringify({ agent: "claude", model: "haiku" }))

  snap = AiBackend.snapshot()
  eq(snap.modelLabel, "opus", "modelLabel does NOT flicker to the newly-loaded config's model — still reflects what this session actually used")

  const resumeArgv = AiBackend.buildHandoffArgv()
  assert(resumeArgv.indexOf("opus") !== -1, "resume argv uses the frozen (opus) model, not the live-reloaded (haiku) one")
  assert(resumeArgv.indexOf("haiku") === -1, "resume argv never leaks the post-submit config change")
}

{
  // P1-10: mid-stream error must not strand undrained text in pendingText —
  // this test covers the AiBackend-only INTERNAL invariant
  // (displayedText === rawText once errored), which is what makes Ctrl+C's
  // rawText copy and the answer panel both complete and consistent. This
  // alone does NOT prove the text is user-visible: whether it's actually
  // rendered on screen depends on Find.qml's aiAnswerText binding also
  // showing displayedText alongside errorMessage on Error (not errorMessage
  // alone) — that half lives in QML and isn't exercised by this Node suite.
  AiBackend.loadConfig(JSON.stringify({ streamFlushMs: 50, drainBaseCps: 1 })) // slow drain so pendingText survives
  AiBackend.cancel()
  const g = AiBackend.beginGeneration("error strands pending test")
  AiBackend.handleLine(g.generation, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AB"}}}')
  AiBackend.handleLine(g.generation, '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"long tail that will not have drained yet"}}}')
  let snap = AiBackend.snapshot()
  assert(snap.pendingText.length > 0, "there is undrained pendingText right before the error (test setup sanity check)")

  const errored = AiBackend.handleLine(g.generation, '{"type":"result","is_error":true,"result":"boom"}')
  eq(errored.state, "error", "adapter error transitions to Error")
  eq(errored.pendingText, "", "pendingText is flushed into displayedText on error, not stranded forever")
  eq(errored.displayedText, errored.rawText, "displayedText equals rawText once errored — the internal invariant this test actually covers")
}

{
  // P1-12: an unsupported `agent` value in ai.json gets a dedicated, clear
  // message distinct from the generic per-field warning (§26.12).
  const r = AiConfig.mergeConfig(JSON.stringify({ agent: "not-a-real-cli" }))
  eq(r.config.agent, "claude", "invalid agent still falls back to the default agent")
  assert(r.warning && r.warning.indexOf("unsupported agent") !== -1, "warning uses the dedicated unsupported-agent wording")
  assert(r.warning.indexOf("not-a-real-cli") !== -1, "warning names the actual invalid value for diagnosability")

  const r2 = AiConfig.mergeConfig(JSON.stringify({ agent: "not-a-real-cli", maxAnswerRows: -1 }))
  assert(r2.warning.indexOf("unsupported agent") !== -1, "dedicated agent wording still wins when other fields are also invalid")
  assert(r2.warning.indexOf("maxAnswerRows") !== -1, "other invalid fields are still mentioned alongside the dedicated agent message")
}

{
  // P0-6 round 2 (QA re-verification): the notify-send late-failure
  // fallback was unreachable dead code. Mechanism: the grace timer's own
  // dismiss() called the generic aiCancel(), which unconditionally bumped
  // aiHandoffAttempt — so by the time the actually-failing terminal's
  // onExited ran, `superseded` was always true and the notify-send branch
  // could never be reached. Fix: dismiss()/aiCancel() gained a
  // preserve/invalidate parameter so ONLY a genuine user-initiated cancel
  // invalidates the attempt token; the grace timer's own "assume success"
  // dismissal does not.
  //
  // This is pure control-flow/token logic with no QML dependency, so it's
  // mirrored here exactly (same shape as the P0-1 mock harness above) to
  // get a real, JS-layer regression test rather than leaving it QML-only.
  function makeHandoffHarness() {
    var state = {
      aiHandoffAttempt: 0,
      handoffProcess: { handled: true, attempt: 0, resumeArgv: null, running: false },
      dismissed: 0,
      dismissedWithPreserve: [],
      notified: [],
      handoffErrorSet: [],
      cancelHandoffCalls: 0
    }

    function aiCancel(invalidateHandoff) {
      if (invalidateHandoff !== false) state.aiHandoffAttempt++
    }

    function dismiss(preserveHandoffAttempt) {
      state.dismissed++
      state.dismissedWithPreserve.push(!!preserveHandoffAttempt)
      aiCancel(!preserveHandoffAttempt)
    }

    function startHandoff(resumeArgv) {
      state.aiHandoffAttempt++
      state.handoffProcess.attempt = state.aiHandoffAttempt
      state.handoffProcess.resumeArgv = resumeArgv
      state.handoffProcess.handled = false
      state.handoffProcess.running = true
    }

    // Mirrors aiHandoffGrace.onTriggered exactly.
    function graceFires() {
      if (state.handoffProcess.handled) return
      state.handoffProcess.handled = true
      if (state.handoffProcess.attempt !== state.aiHandoffAttempt) return
      dismiss(true) // preserveHandoffAttempt — the actual fix
    }

    // Mirrors aiHandoffProcess.onExited exactly.
    function processExits(exitCode) {
      var alreadyHandled = state.handoffProcess.handled
      state.handoffProcess.handled = true
      state.handoffProcess.running = false
      var superseded = state.handoffProcess.attempt !== state.aiHandoffAttempt
      if (exitCode === 0) {
        if (!alreadyHandled && !superseded) dismiss()
        return
      }
      if (superseded) return
      if (!alreadyHandled) {
        state.handoffErrorSet.push(true)
        state.cancelHandoffCalls++
      } else if (state.handoffProcess.resumeArgv) {
        state.notified.push(state.handoffProcess.resumeArgv)
      }
    }

    return { state: state, startHandoff: startHandoff, graceFires: graceFires, processExits: processExits, dismiss: dismiss }
  }

  // Scenario: terminal takes >400ms (grace fires first, optimistic
  // dismiss), THEN actually fails.
  {
    var h = makeHandoffHarness()
    h.startHandoff(["claude", "--resume", "sess-late-fail"])
    h.graceFires() // grace concludes "success" and dismisses
    eq(h.state.dismissed, 1, "grace timeout dismisses the overlay exactly once")
    eq(h.state.dismissedWithPreserve, [true], "the grace-triggered dismiss preserves the handoff attempt token")

    h.processExits(1) // the real process finally fails, after grace already gave up watching
    eq(h.state.notified.length, 1, "the late failure IS surfaced via notify-send — this is the actual P0-6-round-2 fix")
    eq(h.state.notified[0], ["claude", "--resume", "sess-late-fail"], "the notification carries the real resume argv so the user can act on it")
    eq(h.state.handoffErrorSet.length, 0, "no UI error write happens post-dismissal — there is no overlay left to show it in")
  }

  // Control: prove this WOULD have been dead code under the old
  // (unconditional-invalidate) behavior, so the regression test is
  // meaningful and not just restating the new design.
  {
    var h2 = makeHandoffHarness()
    function oldDismiss() { // old behavior: always invalidates, no preserve param
      h2.state.dismissed++
      h2.state.aiHandoffAttempt++
    }
    h2.startHandoff(["claude", "--resume", "sess-old-behavior"])
    // old graceFires() called oldDismiss() unconditionally:
    h2.state.handoffProcess.handled = true
    oldDismiss()
    h2.processExits(1)
    eq(h2.state.notified.length, 0, "under the OLD unconditional-invalidate behavior, the late failure is silently dropped — confirms this is a real regression test, not a restatement")
  }

  // Sanity: a genuine user cancel (Esc/prompt-edit) BEFORE the terminal
  // resolves must still fully invalidate the attempt — notify-send should
  // NOT fire for a handoff the user explicitly walked away from.
  {
    var h3 = makeHandoffHarness()
    h3.startHandoff(["claude", "--resume", "sess-user-cancelled"])
    h3.dismiss() // e.g. Esc — default invalidateHandoff=true, NOT the grace path
    h3.processExits(1) // the abandoned terminal eventually fails anyway
    eq(h3.state.notified.length, 0, "a genuinely user-cancelled handoff attempt does not fire a stale notification")
  }

  // Sanity: fast success (exits 0 before grace ever fires) still dismisses
  // normally and needs no preserve/notify machinery.
  {
    var h4 = makeHandoffHarness()
    h4.startHandoff(["claude", "--resume", "sess-fast-success"])
    h4.processExits(0)
    eq(h4.state.dismissed, 1, "a fast successful exit still dismisses immediately, without waiting for grace")
    eq(h4.state.notified.length, 0, "no notification on a clean success")
  }
}

// ------------------------------------------------------------- summary ----

console.log("")
console.log(pass + " passed, " + fail + " failed")
if (fail > 0) process.exit(1)
