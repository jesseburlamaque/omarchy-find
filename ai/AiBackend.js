.pragma library
.import "AiConfig.js" as AiConfig
.import "AiAdapters.js" as AiAdapters

// AiBackend: owns the AI-mode state machine, the single active AiSession,
// generation-ID guarding, raw/pending/displayed text buffering, and the
// bounded adaptive display drain. See implementation plan §2-§4, §16-§17.
//
// This file never touches Quickshell.Process or Quickshell.execDetached
// directly — Find.qml owns every actual OS-facing call (spawning the
// tracked Process, and the fire-and-forget cleanup/terminal calls) and this
// module only ever hands back plain data (argv arrays, snapshots). That
// keeps "what to run" (here) cleanly separated from "how to run it" (QML),
// and sidesteps any ambiguity around whether a `.pragma library` script can
// reach the Quickshell C++ singleton API.
//
// Architectural invariant: only one AiSession is ever active. Every
// callback from process I/O is tagged with the generation it belongs to;
// handleLine/handleExit silently drop anything that doesn't match the
// generation of the currently active session (see isStale()).

var State = {
  Idle: "idle",
  Starting: "starting",
  Running: "running",
  Draining: "draining",
  Ready: "ready",
  Handoff: "handoff",
  Error: "error"
}

// ---------------------------------------------------------------- drain ---
//
// Streaming "typewriter" tuning (rewritten after live-overlay feedback: the
// original two-regime normal+boost formula at 50ms/20Hz ticks produced
// visibly chunky, bursty reveal — lag would build up then dump in one jump
// once the bounded backlogBoost kicked in). The replacement is a single
// continuous catch-up law — see catchUpChars() — driven by a much faster
// tick (Find.qml's aiDrainTimer, ~16ms/60Hz) so reveal rate scales smoothly
// with how far behind the display currently is: small backlog -> small
// reveal, sudden CLI burst -> proportionally bigger reveal that same tick,
// no separate "boost mode" to visibly kick in or stall out of.
//
// DRAIN_HALF_LIFE_MS: each tick reveals a fraction `alpha` of whatever is
// still pending, where alpha is derived (per actual tick interval, so this
// stays correct even if a user's ai.json overrides the tick rate) so that
// a backlog shrinks by half every DRAIN_HALF_LIFE_MS of real time. 130ms
// (within the requested 120-180ms range) keeps typical perceived lag in the
// ~200-300ms band that reads as "closely tracking the model" rather than
// either an instant dump or a noticeable trail.
var DRAIN_HALF_LIFE_MS = 130

// A pure exponential decay has a long individually-slow tail once the
// backlog gets small (each tick reveals a shrinking fraction of an already-
// shrinking number), so the ~2-char floor mentioned in the original ask
// would, on its own, spend a large chunk of the whole reveal time crawling
// through the LAST ~20-30 characters at only 2/tick — verified by
// simulating a real captured multi-chunk claude answer with a deliberate
// same-tick burst (see the smoothness regression test): 2-char floor
// pushed worst-case simulated lag to ~480-528ms, over budget. 4 chars/tick
// (still small/imperceptible as a single-tick reveal) roughly halves that
// tail cost and keeps worst-case lag comfortably under the ~400ms bar
// without needing a shorter half-life than requested.
var MIN_REVEAL_FLOOR_CHARS = 4

// Once Draining starts (the process has already exited — the full answer is
// fully known and nothing new is coming), the exponential catch-up law
// above is combined with a hard wall-clock deadline so a very large backlog
// can't ride the asymptote forever: the whole thing must be gone within
// this many milliseconds of entering Draining, no matter its size.
var DRAIN_MAX_MS = 300

var Activity = {
  None: null,
  Thinking: "thinking",
  Searching: "searching"
}

var currentGeneration = 0
var runtimeConfig = AiConfig.defaults()
var session = null       // active AiSession, or null when idle
var parserState = null   // adapter-owned scratch space for the active session

// ------------------------------------------------------------- config -----

// rawText is the FileView's text() result, or "" if the file doesn't exist.
// Never writes/creates the config file — purely reads whatever text is handed in.
// Returns { config, warning }; the caller (Find.qml) is the one that keeps
// hold of `warning` for display — nothing here needs to remember it.
function loadConfig(rawText) {
  var result = AiConfig.mergeConfig(rawText)
  runtimeConfig = result.config
  return result
}

function getConfig() { return runtimeConfig }

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Mirrors Find.qml's existing `/^\s*go\s+/i` prefix pattern for the "go "
// web-search mode, but for a configurable prefix (default "ai "). Returns
// the prompt text after the prefix, or null if filterText isn't in AI mode.
function matchPrefix(filterText, prefix) {
  var p = String(prefix === undefined || prefix === null ? runtimeConfig.prefix : prefix).replace(/\s+$/, "")
  if (!p) return null
  var re = new RegExp("^\\s*" + escapeRegExp(p) + "\\s+", "i")
  var m = String(filterText || "").match(re)
  if (!m) return null
  return String(filterText).slice(m[0].length)
}

// What the idle chip should show before any generation has ever started:
// "AI · <Label>" (+ "· <model>" if configured). Pure function of config.
function agentDisplay() {
  var adapter = AiAdapters.get(runtimeConfig.agent)
  return {
    agentId: runtimeConfig.agent,
    agentLabel: adapter ? adapter.label : runtimeConfig.agent,
    binary: adapter ? adapter.binary : runtimeConfig.agent,
    modelLabel: runtimeConfig.model || null,
    supported: adapter !== null
  }
}

// -------------------------------------------------------- generation ------

// Starts a brand-new generation, tearing down whatever was active first (at
// most one AiSession is ever alive). Returns { generation, argv } where argv
// is already wrapped for process-group isolation (see wrapForGroup) and
// ready to assign directly to Process.command — or argv: null if the
// configured agent isn't a known adapter (unsupported-agent config error).
function beginGeneration(promptText) {
  session = null
  parserState = null

  currentGeneration++
  var gen = currentGeneration
  var adapter = AiAdapters.get(runtimeConfig.agent)

  // Frozen at spawn time (plan-adjacent hardening, QA P1-8): if ai.json
  // changes mid-run, resume must still use exactly the agent/model that
  // produced this answer, not whatever the file says by the time Enter is
  // pressed. `runtimeConfig` itself is always replaced wholesale by a fresh
  // object on the next loadConfig() (see AiConfig.mergeConfig), never
  // mutated in place, so holding this reference is enough — no copy needed.
  var frozenConfig = runtimeConfig

  if (!adapter) {
    session = {
      generation: gen,
      adapterId: runtimeConfig.agent,
      agentLabel: runtimeConfig.agent,
      sessionRef: null,
      state: State.Error,
      activity: null,
      rawText: "", displayedText: "", pendingText: "",
      startedAt: Date.now(),
      canHandoff: false,
      errorMessage: "Unsupported agent \"" + runtimeConfig.agent + "\" in ai.json",
      errorKind: "config",
      continuity: "none",
      stderrText: "",
      prompt: promptText,
      config: frozenConfig
    }
    return { generation: gen, argv: null }
  }

  var sessionRef = adapter.capabilities.continuity === "caller-id" ? adapter.createSessionRef() : null

  session = {
    generation: gen,
    adapterId: adapter.id,
    agentLabel: adapter.label,
    sessionRef: sessionRef,
    state: State.Starting,
    activity: null,
    rawText: "", displayedText: "", pendingText: "",
    startedAt: Date.now(),
    canHandoff: false,
    errorMessage: null,
    errorKind: null,
    continuity: adapter.capabilities.continuity,
    stderrText: "",
    prompt: promptText,
    config: frozenConfig
  }
  parserState = {}

  var argv = adapter.buildRun(promptText, sessionRef, runtimeConfig)
  return { generation: gen, argv: wrapForGroup(argv) }
}

function isStale(gen) {
  return !session || gen !== session.generation || session.generation !== currentGeneration
}

// -------------------------------------------------------- slot picking ----
//
// Find.qml keeps exactly two Process elements to spawn the agent CLI into
// (ping-pong instead of one, precisely to avoid reusing a single Process
// object mid-teardown). This is the ONE place that decides whether either
// slot may be handed a new command right now — Find.qml calls it both at
// submit time and whenever a slot's process actually exits, passing in the
// two Processes' live `running` values, and never assigns command/running
// itself without going through this first.
//
// Verified Quickshell fact (quickshell/src/io/process.cpp): Process.running
// stays true until the OS process has genuinely exited — even after the
// caller sets running=false to request termination (that only calls
// QProcess::terminate()). Assigning a NEW command + running=true to a
// Process whose running still reads true does not start anything: it
// silently latches a deferred start that fires only once the OLD OS
// process's own exit handling finishes (after its stdout parser flushes any
// remainder and after `exited` is emitted) — by which point any `.gen` tag
// on that Process object has already been overwritten by the new
// assignment, so the OLD run's last stdout/exit events get misattributed to
// the NEW generation (this was a real, confirmed bug — spec §26.4). The
// only correct rule: never assign to a slot whose `running` reads true.
// When both are busy, the caller must queue instead.
function pickFreeSlot(slotABusy, slotBBusy) {
  if (!slotABusy) return "A"
  if (!slotBBusy) return "B"
  return null
}

// ------------------------------------------------------------- events -----

function handleLine(gen, line) {
  if (isStale(gen)) return null
  var adapter = AiAdapters.get(session.adapterId)
  if (!adapter) return snapshot()
  var events
  try {
    events = adapter.parseLine(line, parserState)
  } catch (e) {
    events = []
  }
  for (var i = 0; i < events.length; i++) applyEvent(events[i])
  return snapshot()
}

function applyEvent(ev) {
  if (!ev || !session) return
  if (session.state === State.Starting) session.state = State.Running
  switch (ev.type) {
    case "session":
      if (ev.sessionRef) session.sessionRef = ev.sessionRef
      break
    case "text":
      appendText(ev.text)
      break
    case "activity":
      session.activity = ev.activity
      break
    case "tool":
      break
    case "error":
      setError(ev.message, "adapter")
      break
    default:
      break
  }
}

// Cap on how much of the FIRST chunk gets the immediate-render treatment.
// Claude/agy stream small token-sized deltas so this never matters for
// them, but Codex's adapter (and any future one) can hand back a whole
// item's text as a single "delta" the first time it's seen — without this
// cap, that entire answer would skip pendingText/drain pacing altogether
// (the exact opposite of "burst normalization", plan §17).
var FIRST_CHUNK_IMMEDIATE_MAX = 80

function appendText(delta) {
  if (!delta || !session) return
  session.rawText += delta
  // First meaningful text renders immediately (minimum perceived TTFC);
  // everything after — and anything beyond the cap even on the very first
  // delta — goes through the paced drain in tick().
  if (session.displayedText.length === 0 && session.pendingText.length === 0) {
    if (delta.length <= FIRST_CHUNK_IMMEDIATE_MAX) {
      session.displayedText += delta
    } else {
      session.displayedText += delta.slice(0, FIRST_CHUNK_IMMEDIATE_MAX)
      session.pendingText += delta.slice(FIRST_CHUNK_IMMEDIATE_MAX)
    }
  } else {
    session.pendingText += delta
  }
}

function setError(message, kind) {
  if (!session) return
  // Nothing drains once in Error state (the display timer only runs for
  // Running/Draining), so any text already received but not yet displayed
  // would otherwise be stranded in pendingText forever — Ctrl+C already
  // copies rawText correctly per §16, but the visible panel should show
  // everything too. This alone only fixes the internal invariant
  // (displayedText === rawText even after an error); the answer panel in
  // Find.qml (aiAnswerText) is what actually renders displayedText
  // alongside errorMessage on Error instead of errorMessage alone — both
  // halves are required for the partial answer to actually be visible.
  if (session.pendingText.length > 0) {
    session.displayedText += session.pendingText
    session.pendingText = ""
  }
  session.state = State.Error
  session.errorMessage = message || "Unknown error"
  session.errorKind = kind || "unknown"
  session.canHandoff = false
  session.activity = null
}

function handleStderrChunk(gen, chunk) {
  if (isStale(gen)) return
  session.stderrText += String(chunk || "")
}

// exitCode: the OS exit code of the (setsid-wrapped) agent process.
function handleExit(gen, exitCode) {
  if (isStale(gen)) return null
  if (session.state === State.Error) return snapshot()

  var adapter = AiAdapters.get(session.adapterId)

  // Defense in depth: no deltas were captured on the way through, but the
  // adapter did see one authoritative final string (e.g. Claude's "result"
  // event carries the full answer even if partial-message deltas were,
  // for some reason, never emitted).
  if (session.rawText.length === 0 && parserState &&
      typeof parserState.finalText === "string" && parserState.finalText.length > 0) {
    appendText(parserState.finalText)
  }

  var producedNothing = session.rawText.length === 0 && session.pendingText.length === 0
  if (exitCode !== 0 || producedNothing) {
    var classification = adapter ? adapter.classifyFailure(exitCode, session.stderrText) : null
    if (!classification) {
      // Unclassified failure — §19 asks to at least log the raw output even
      // when we can't produce a specific message for it.
      if (session.stderrText) console.warn("[omarchy-find/ai] unclassified failure, raw stderr: " + session.stderrText)
      classification = {
        message: producedNothing
          ? (session.agentLabel + " produced no output" + (exitCode !== 0 ? " (exit " + exitCode + ")" : ""))
          : (session.agentLabel + " exited unexpectedly (exit " + exitCode + ")"),
        kind: "unknown"
      }
    }
    setError(classification.message, classification.kind)
  } else {
    session.state = State.Draining
    session.drainTicksElapsed = 0
    if (session.pendingText.length === 0) finishDraining()
  }
  return snapshot()
}

function finishDraining() {
  session.state = State.Ready
  session.canHandoff = session.sessionRef !== null && session.continuity !== "none"
}

// -------------------------------------------------------------- drain -----

// Single continuous catch-up law (replaces the old normal+boost two-regime
// formula, which ticked at 20Hz and produced visibly chunky/bursty reveal —
// lag would build up, then dump all at once once a hard per-tick cap capped
// the "catch up" side unevenly). Reveal a fixed FRACTION of whatever is
// still pending each tick, so the amount shown scales continuously with how
// far behind the display is: a small backlog reveals a small amount, a
// sudden CLI burst reveals proportionally more that same tick and melts
// away over the next few ticks — never a separate "boost mode" visibly
// kicking in or a hard cap causing a stall. `minCps` (config's
// drainBaseCps, now meaning "minimum reveal rate") sets a floor so very
// thin trickles of text don't slow to an imperceptible crawl.
function catchUpChars(pendingLength, dtMs, minCps) {
  if (pendingLength <= 0) return 0
  var dt = Math.max(1, dtMs)
  // Fraction of the remaining backlog to reveal this tick, derived from the
  // ACTUAL tick interval so the real-time half-life stays DRAIN_HALF_LIFE_MS
  // regardless of a configured streamFlushMs — halves the backlog every
  // DRAIN_HALF_LIFE_MS of wall-clock time (a geometric/exponential decay,
  // not a linear cap): alpha solves (1-alpha)^(dt/halfLife) = 0.5.
  var alpha = 1 - Math.pow(0.5, dt / DRAIN_HALF_LIFE_MS)
  var floorChars = Math.max(MIN_REVEAL_FLOOR_CHARS, Math.round((Math.max(1, minCps) * dt) / 1000))
  var chars = Math.ceil(pendingLength * alpha)
  if (chars < floorChars) chars = floorChars
  if (chars > pendingLength) chars = pendingLength
  return chars
}

// Draining-only addition: the process has already exited — the full answer
// is fully known and nothing new is coming — so on top of the same smooth
// catchUpChars() law, a hard wall-clock deadline (DRAIN_MAX_MS) guarantees
// even a very large backlog can't ride the exponential's asymptote forever.
// Tracked as an elapsed-TICK count rather than a raw Date.now() deadline —
// exact and deterministic regardless of system clock jitter, and testable
// without real delays — but the tick budget itself is derived from
// DRAIN_MAX_MS / the actual tick interval, so it stays correct if a user's
// ai.json overrides streamFlushMs. Never slower than the base catch-up law
// either (Math.max), so this only ever speeds up the tail of a big backlog.
function drainingChars(pendingLength, dtMs, ticksElapsed, minCps) {
  var dt = Math.max(1, dtMs)
  var maxTicks = Math.max(1, Math.ceil(DRAIN_MAX_MS / dt))
  var ticksLeft = Math.max(1, maxTicks - ticksElapsed)
  var byDeadline = Math.ceil(pendingLength / ticksLeft)
  var byRate = catchUpChars(pendingLength, dtMs, minCps)
  return Math.min(pendingLength, Math.max(byDeadline, byRate))
}

// Called on a fixed timer (streamFlushMs, now meaning "tick interval",
// default 16ms/60Hz — see AiConfig.js) while state is running/draining.
// Returns null on a genuine no-op tick (nothing was pending, nothing
// transitioned) so the caller can skip reassigning the QML-bound snapshot
// property entirely on idle ticks (perf: avoid needless Text re-layout).
function tick() {
  if (!session) return null
  if (session.pendingText.length === 0) return null
  var chars
  if (session.state === State.Draining) {
    chars = drainingChars(session.pendingText.length, runtimeConfig.streamFlushMs, session.drainTicksElapsed || 0, runtimeConfig.drainBaseCps)
    session.drainTicksElapsed = (session.drainTicksElapsed || 0) + 1
  } else {
    chars = catchUpChars(session.pendingText.length, runtimeConfig.streamFlushMs, runtimeConfig.drainBaseCps)
  }
  if (chars > 0) {
    session.displayedText += session.pendingText.slice(0, chars)
    session.pendingText = session.pendingText.slice(chars)
  }
  if (session.state === State.Draining && session.pendingText.length === 0) finishDraining()
  return snapshot()
}

// ------------------------------------------------------------ lifecycle ---

// Full teardown back to Idle. Bumping currentGeneration is not required for
// correctness (isStale() already keys off session identity, and session is
// cleared here), but any in-flight process the caller is about to kill will
// naturally have its late callbacks ignored once session is null.
function cancel() {
  session = null
  parserState = null
}

// -------------------------------------------------------------- render ----

function snapshot() {
  if (!session) {
    var disp = agentDisplay()
    return {
      generation: currentGeneration,
      adapterId: disp.agentId,
      agentLabel: disp.agentLabel,
      modelLabel: disp.modelLabel,
      supported: disp.supported,
      sessionRef: null,
      state: State.Idle,
      activity: null,
      rawText: "", displayedText: "", pendingText: "",
      prompt: "",
      canHandoff: false,
      errorMessage: disp.supported ? null : ("Unsupported agent \"" + disp.agentId + "\" in ai.json"),
      errorKind: disp.supported ? null : "config",
      continuity: "none"
    }
  }
  return {
    generation: session.generation,
    adapterId: session.adapterId,
    agentLabel: session.agentLabel,
    // Reflects the config frozen at spawn time, not whatever ai.json says
    // right now — a mid-run edit shouldn't make the chip flicker to a model
    // this answer wasn't actually generated with (QA P1-8).
    modelLabel: (session.config && session.config.model) || null,
    supported: true,
    sessionRef: session.sessionRef,
    state: session.state,
    activity: session.activity,
    rawText: session.rawText,
    displayedText: session.displayedText,
    pendingText: session.pendingText,
    prompt: session.prompt || "",
    canHandoff: session.canHandoff,
    errorMessage: session.errorMessage,
    errorKind: session.errorKind,
    continuity: session.continuity
  }
}

// -------------------------------------------------------------- handoff ---

// Only valid once Ready + canHandoff. Returns argv for the CLI's own resume
// command (never a shell string) or null when handoff isn't currently safe.
// Uses the config frozen at spawn time (see beginGeneration), not whatever
// ai.json says right now (QA P1-8) — e.g. a model override that changed
// mid-run must not leak into the resume argv for a session it never ran.
function buildHandoffArgv() {
  if (!session || session.state !== State.Ready || !session.canHandoff || !session.sessionRef) return null
  var adapter = AiAdapters.get(session.adapterId)
  if (!adapter) return null
  return adapter.buildResume(session.sessionRef, session.config || runtimeConfig)
}

// Marks the session as mid-handoff so a second Enter (or key auto-repeat)
// can't dispatch a second terminal onto the same session — plan §4 has a
// dedicated Handoff state for exactly this (QA P0-3). Call buildHandoffArgv()
// FIRST (it still requires state === Ready), then this to transition, then
// spawn the terminal. Returns the new snapshot, or null if handoff wasn't
// actually available right now (stale call — caller should no-op).
function beginHandoff() {
  if (!session || session.state !== State.Ready || !session.canHandoff) return null
  session.state = State.Handoff
  return snapshot()
}

// Only used by the caller's terminal-launch failure path to let Enter be
// tried again instead of stranding the session in Handoff forever.
function cancelHandoff() {
  if (!session || session.state !== State.Handoff) return null
  session.state = State.Ready
  return snapshot()
}

// -------------------------------------------------------- process utils ---

// Wraps argv so the agent CLI becomes its own session/process-group leader
// (setsid execs in place — same PID, no fork/wait semantics to worry
// about — verified empirically against this machine's util-linux setsid).
// That lets killArgv() below signal the whole group with one negative-PID
// kill instead of only the direct child.
function wrapForGroup(argv) {
  return ["setsid"].concat(argv)
}

function killArgv(pid, signalName) {
  return ["kill", "-" + (signalName || "TERM"), "-" + String(pid)]
}
