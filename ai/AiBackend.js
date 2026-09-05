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
// Streaming "typewriter" law (third iteration, after live-overlay feedback
// that BOTH previous formulas still burst: the backlog-proportional
// catch-up revealed ~8% of whatever was pending per 16ms frame, so a large
// CLI chunk — codex whole-item deltas, claude sentence-sized deltas landing
// together — became a visible on-screen dump, and the old 300ms hard drain
// deadline flooded the whole tail out the moment the process exited).
//
// The replacement is rate-over-TIME, never rate-over-backlog: the reveal
// rate starts at a readable typewriter pace and grows EXPONENTIALLY with
// how long the answer has been revealing, up to a smooth per-frame cap.
// How much text is queued has zero effect on how much one tick shows, so a
// burst from the CLI can never become a burst on screen — it only makes
// the (accelerating) typewriter run longer. Total reveal time grows only
// logarithmically with answer length, so no hard deadline is needed:
//   rate(t) = drainBaseCps * 2^(t / rampDoubleMs), capped at maxCps
// where t counts only ACTIVE reveal time (ticks that had pending text), so
// a mid-answer thinking pause freezes the ramp instead of inflating it.
// All three knobs live in AiConfig (ai.json-overridable): drainBaseCps=60
// start, rampDoubleMs=500 doubling period, maxCps=2400 cap (~38 chars per
// 16ms frame — a fast smooth scroll, not a dump).

// Once Draining starts the process has already exited — the full answer is
// known and nothing new is coming — so the ramp clock simply advances this
// many times faster. The rate stays continuous across the transition and
// keeps the same exponential shape; the tail just accelerates sooner
// instead of ever being dumped by a deadline.
var DRAIN_RAMP_ACCEL = 2

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
function loadConfig(rawText, omarchyAgent) {
  var result = AiConfig.mergeConfig(rawText, omarchyAgent)
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
    // Give a targeted hint for agents the user has set via Omarchy's own
    // default-agent system but that don't yet have a headless adapter here.
    // This is far better UX than a generic "unsupported agent" error that
    // implies the user made a mistake in ai.json.
    var knownOmarchyAgents = ["gemini", "copilot", "grok", "omp", "crush"]
    var isKnownOmarchy = knownOmarchyAgents.indexOf(runtimeConfig.agent) !== -1
    var errorMsg = isKnownOmarchy
      ? runtimeConfig.agent + " does not yet support headless AI mode. " +
        "Switch your Omarchy agent to claude, codex, agy, opencode, or pi " +
        "(or create ~/.config/omarchy-find/ai.json with one of those agents)."
      : "Unsupported agent \"" + runtimeConfig.agent + "\" — check ai.json. " +
        "Supported agents: claude, codex, agy, opencode, pi."
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
      errorMessage: errorMsg,
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
    config: frozenConfig,
    // Typewriter ramp state (see tick()): active reveal time accumulated so
    // far, and the fractional-character carry between ticks.
    revealElapsedMs: 0,
    revealCarry: 0
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

function appendText(delta) {
  if (!delta || !session) return
  // EVERY character goes through the paced typewriter in tick() — there is
  // deliberately no first-chunk immediate-render fast path anymore (live
  // feedback: even an 80-char "first sentence" flash reads as a burst, and
  // the CLIs' first delta is often a whole sentence). TTFC is still ~one
  // display tick (16ms) since the drain timer runs the whole time.
  session.rawText += delta
  session.pendingText += delta
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
    if (session.pendingText.length === 0) finishDraining()
  }
  return snapshot()
}

function finishDraining() {
  session.state = State.Ready
  session.canHandoff = session.sessionRef !== null && session.continuity !== "none"
}

// -------------------------------------------------------------- drain -----

// Current reveal rate in chars/sec for a session that has spent
// `elapsedMs` of active reveal time so far: exponential ramp from the
// configured starting pace, doubling every rampDoubleMs, capped at maxCps.
// Deliberately a function of TIME only — never of backlog size (see the
// header comment above: backlog-proportional reveal is what burst).
function rampRateCps(elapsedMs, cfg) {
  var rate = cfg.drainBaseCps * Math.pow(2, elapsedMs / cfg.rampDoubleMs)
  return rate < cfg.maxCps ? rate : cfg.maxCps
}

// Called on a fixed timer (streamFlushMs = tick interval, default 16ms/60Hz
// — see AiConfig.js) while state is running/draining. Returns null on a
// tick that changed nothing visible (nothing pending, or the sub-character
// carry hasn't accumulated a whole char yet) so the caller can skip
// reassigning the QML-bound snapshot property (perf: avoid needless Text
// re-layout).
function tick() {
  if (!session) return null
  if (session.pendingText.length === 0) return null
  var dt = Math.max(1, runtimeConfig.streamFlushMs)
  var cfg = runtimeConfig
  // Rate is sampled BEFORE advancing the clock so the very first active
  // tick reveals at exactly drainBaseCps. `revealCarry` accumulates the
  // fractional character per tick (60cps at 60Hz is <1 char/frame) so the
  // slow start is smooth and no characters are gained or lost to rounding.
  var exact = (rampRateCps(session.revealElapsedMs, cfg) * dt) / 1000 + session.revealCarry
  var chars = Math.floor(exact)
  session.revealCarry = exact - chars
  if (chars > session.pendingText.length) {
    chars = session.pendingText.length
    session.revealCarry = 0
  }
  // The ramp clock counts only ACTIVE reveal time (this branch is behind
  // the pendingText check above), so mid-answer thinking pauses freeze the
  // ramp rather than inflating it. Draining advances the clock faster —
  // see DRAIN_RAMP_ACCEL — but through the same continuous law.
  session.revealElapsedMs += dt * (session.state === State.Draining ? DRAIN_RAMP_ACCEL : 1)
  if (chars > 0) {
    session.displayedText += session.pendingText.slice(0, chars)
    session.pendingText = session.pendingText.slice(chars)
  }
  if (session.state === State.Draining && session.pendingText.length === 0) {
    finishDraining()
    return snapshot()
  }
  return chars > 0 ? snapshot() : null
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
