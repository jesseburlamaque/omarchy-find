import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "FindBackend.js" as Backend
import "ai/AiBackend.js" as AiBackend

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  property bool opened: false
  // Starts narrow, expands when typing or button clicked.
  property bool expanded: false
  // Manual expansion persists when text is cleared.
  property bool manualExpand: false
  property string filterText: ""
  property int selectedIndex: 0
  property int activeFilter: 0
  property bool searching: false
  property string home: Quickshell.env("HOME")

  readonly property bool isGoogleSearch: /^\s*go\s+/i.test(root.filterText)
  readonly property string googleSearchTerms: isGoogleSearch ? root.filterText.replace(/^\s*go\s+/i, "").trim() : ""

  // AI search mode ("ai <question>"). Mirrors the go-search prefix pattern
  // above. All AI state/behavior lives in AiBackend.js — this file only
  // renders whatever it hands back via root.aiSession snapshots.
  property string aiPrefix: "ai "
  readonly property var aiPromptOrNull: AiBackend.matchPrefix(root.filterText, root.aiPrefix)
  readonly property bool isAiMode: root.aiPromptOrNull !== null
  readonly property string aiPromptText: root.isAiMode ? root.aiPromptOrNull : ""
  property var aiSession: null
  property bool aiConfigLoaded: false
  property string aiConfigWarning: ""
  // Sentinel `undefined` (never applied yet) distinguishes "first load" from
  // "reloaded to an empty file" (""); reloaded to "absent" is `null`. Lets
  // applyAiConfig() short-circuit a redundant reload (e.g. the watchdog
  // Timer firing when nothing actually changed) as a genuine no-op instead
  // of re-touching aiSession/binary-check on every firing.
  property var aiConfigLastRawText: undefined
  property int aiStreamFlushMs: 16
  property int aiMaxAnswerRows: 6
  property bool aiBinaryChecked: false
  property bool aiBinaryMissing: false
  property string aiBinaryCheckedFor: ""
  property var aiPendingSpawn: null
  property int aiHandoffAttempt: 0
  property string aiHandoffError: ""
  readonly property int aiLineHeight: Math.round(Style.font.body * 1.45)
  readonly property int aiAnswerMaxHeight: root.aiMaxAnswerRows * root.aiLineHeight
  readonly property int aiChipRowHeight: Math.max(Style.space(26), Style.font.body + Style.space(10))

  // Entering/leaving AI mode (prefix typed, deleted, or cleared) is the
  // single choke point for lifecycle: entering does cheap local setup only
  // (config already loaded, just resolve+check the binary — never spawns a
  // process); leaving tears down any in-flight generation so no agent
  // process ever survives the prefix being edited away, Esc, Ctrl+U, or the
  // overlay closing (plan §20, §26.11).
  onIsAiModeChanged: {
    if (root.isAiMode) {
      root.aiSession = AiBackend.snapshot()
      root.ensureAiBinaryChecked()
    } else {
      root.aiCancel()
      root.aiSession = null
      root.aiHandoffError = ""
    }
  }

  // Protects against out-of-order search results.
  property int searchGen: 0
  property bool rerunPending: false
  property int pendingProcs: 0
  property var pendingItems: []
  property bool mtimesLoaded: false

  // Shared theme colors with menu.
  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  property color accent: Color.accent
  property color chipActive: Util.alpha(Color.accent, 0.22)
  property color chipHover: Util.alpha(Color.accent, 0.10)
  property color chipIdle: Util.alpha(Color.menu.text, 0.07)
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  // System locale.
  readonly property string locale: Qt.locale().name
  property int contentMargin: Style.spacing.panelPadding
  property int contentSpacing: Style.spacing.md
  property int headerHeight: Math.max(Style.space(34), Style.font.title + Style.spacing.controlPaddingY * 2)
  property int cardWidth: Math.min(Style.space(660), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(520), panel.height - Style.gapsOut * 2)
  property int rowHeight: Math.max(Style.space(44), Style.font.body + Style.space(20))
  property string sortMode: "relevance"
  property bool sortMenuOpen: false
  property var rawItems: []
  property var mtimesMap: ({})
  property int displayLimit: 60
  readonly property var displayLimitSteps: [15, 30, 60, 100, 200]

  function cycleDisplayLimit() {
    var steps = root.displayLimitSteps
    var idx = steps.indexOf(root.displayLimit)
    var nextIdx = (idx + 1) % steps.length
    root.displayLimit = steps[nextIdx]
    root.presentResults(root.rawItems)
  }

  function pluginId() {
    return (root.manifest && root.manifest.id) || "jesseburlamaque.omarchy-find"
  }

  function open(payloadJson) {
    var query = ""
    try {
      var payload = JSON.parse(payloadJson || "{}")
      if (payload && typeof payload.query === "string") query = payload.query
    } catch (e) { /* fallback on invalid payload */ }
    root.opened = true
    root.activeFilter = 0
    root.manualExpand = false
    root.sortMenuOpen = false
    root.setFilter(query)
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function cancelProcs() {
    debounce.stop()
    if (procDirs.running) procDirs.running = false
    if (procFiles.running) procFiles.running = false
    if (procStat.running) procStat.running = false
    root.pendingProcs = 0
    root.rerunPending = false
    root.searching = false
  }

  function close() {
    root.cancelProcs()
    root.aiCancel()
    // AI mode is derived from filterText, which close()/dismiss() don't
    // touch — re-summoning later with a DIFFERENT "ai ..." query while
    // isAiMode stays true the whole time never fires onIsAiModeChanged, so
    // without this the stale Ready snapshot (old answer, old canHandoff)
    // would still be showing under the new question (QA P0-5).
    root.aiSession = AiBackend.snapshot()
    root.opened = false
  }

  function switchPanel(direction) {
    if (root.shell && root.shell.bars) {
      for (var i = 0; i < root.shell.bars.length; i++) {
        var b = root.shell.bars[i]
        if (b && typeof b.switchPanelFrom === "function" && typeof b.moduleWidgets === "function") {
          var widgets = b.moduleWidgets(root.pluginId())
          if (widgets && widgets.length > 0) {
            if (b.switchPanelFrom(widgets[0], direction)) {
              root.dismiss()
              return true
            }
          }
        }
      }
    }
    return false
  }

  // preserveHandoffAttempt: true ONLY for the grace-timer's own "assume the
  // terminal launched fine" dismissal (see aiHandoffGrace below) — that
  // dismiss is not a user cancelling anything, it's this same handoff
  // attempt optimistically concluding, and the OS process might still be
  // alive and might still fail. Invalidating the attempt token here would
  // make aiHandoffProcess.onExited's `superseded` check always true for
  // that attempt, permanently discarding a real late failure (QA P0-6
  // round 2 — this was previously unreachable dead code for exactly this
  // reason: every dismiss(), including this one, bumped the token before
  // the failing process could ever be correlated back to it).
  function dismiss(preserveHandoffAttempt) {
    root.cancelProcs()
    root.aiCancel(!preserveHandoffAttempt)
    root.aiSession = AiBackend.snapshot() // see close() — same stale-snapshot fix (QA P0-5)
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide(root.pluginId())
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function debugState() {
    return JSON.stringify({
      opened: root.opened,
      expanded: root.expanded,
      activeFilter: root.activeFilter,
      filterText: root.filterText,
      count: displayModel.count,
      searching: root.searching
    })
  }

  function setFilter(nextFilter) {
    root.filterText = nextFilter
    root.selectedIndex = 0
    if (nextFilter.trim() !== "") root.expanded = true
    else if (!root.manualExpand) root.expanded = false

    if (root.isGoogleSearch) {
      root.cancelProcs()
      displayModel.clear()
      var terms = root.googleSearchTerms
      if (terms.length > 0) {
        displayModel.append({
          path: "https://www.google.com/search?q=" + encodeURIComponent(terms),
          name: Backend.t("searchGoogleFor", root.locale) + terms + "\"",
          dir: Backend.t("googleSearch", root.locale),
          icon: "󰍉",
          isDir: false,
          mtime: ""
        })
      }
      return
    }

    if (root.isAiMode) {
      // AI prompt text edits never trigger a file search — see AiBackend.js
      // for everything that actually happens in AI mode (nothing spawns
      // merely from typing; see plan §13).
      root.cancelProcs()
      displayModel.clear()
      return
    }

    if (displayModel.count > 0 && displayModel.get(0).dir === Backend.t("googleSearch", root.locale)) {
      displayModel.clear()
    }

    debounce.restart()
  }

  // Expand card to browse (lists recent files if query is empty).
  function expandForBrowse() {
    root.manualExpand = true
    root.expanded = true
    root.runSearch()
  }

  function collapseView() {
    root.manualExpand = false
    root.expanded = false
  }

  function setActiveFilter(index) {
    if (index === root.activeFilter) return
    root.activeFilter = index
    root.selectedIndex = 0
    root.runSearch()
  }

  function cycleFilter(delta) {
    var count = Backend.FILTERS.length
    root.setActiveFilter((root.activeFilter + delta + count) % count)
  }

  // Search

  function runSearch() {
    // Search only when expanded and not in Google search or AI mode.
    if (!root.expanded || root.isGoogleSearch || root.isAiMode) return
    root.searchGen++
    if (procDirs.running || procFiles.running) {
      root.rerunPending = true
      return
    }
    root.launchSearch()
  }

  function launchSearch() {
    root.rerunPending = false
    root.searching = true
    root.pendingItems = []
    root.mtimesLoaded = false
    var filter = Backend.FILTERS[root.activeFilter] || Backend.FILTERS[0]
    var pending = 0
    if (filter.dirs) {
      pending++
      procDirs.gen = root.searchGen
      procDirs.command = Backend.buildArgv(root.filterText, root.activeFilter, true, root.home)
      procDirs.running = true
    }
    if (filter.files) {
      pending++
      procFiles.gen = root.searchGen
      procFiles.command = Backend.buildArgv(root.filterText, root.activeFilter, false, root.home)
      procFiles.running = true
    }
    root.pendingProcs = pending
    if (pending === 0) {
      root.searching = false
      root.presentResults([])
    }
  }

  function procFinished(proc, text) {
    if (root.isGoogleSearch) return
    if (proc.gen === root.searchGen) {
      root.pendingItems = root.pendingItems.concat(
        Backend.parseLines(text, proc.kind === "d", root.home))
    }
    root.pendingProcs--
    if (root.pendingProcs > 0) return
    root.searching = false
    if (root.rerunPending) {
      root.launchSearch()
      return
    }
    root.presentResults(root.pendingItems)
  }

  function presentResults(items) {
    if (root.isGoogleSearch) return
    root.rawItems = items || []
    for (var j = 0; j < root.rawItems.length; j++) {
      var it = root.rawItems[j]
      if (root.mtimesMap[it.path] !== undefined) {
        it.mtimeMs = root.mtimesMap[it.path]
      }
    }
    var ranked = Backend.rankResults(root.rawItems, root.filterText, root.displayLimit, root.home, root.sortMode)
    displayModel.clear()
    var now = Date.now()
    for (var i = 0; i < ranked.length; i++) {
      var ms = ranked[i].mtimeMs
      displayModel.append({
        path: ranked[i].path,
        name: ranked[i].name,
        dir: ranked[i].dir,
        icon: ranked[i].icon,
        isDir: ranked[i].isDir,
        mtimeMs: ms !== undefined ? ms : 0,
        mtime: ms ? Backend.formatMtime(ms, now, root.locale) : ""
      })
    }
    if (root.selectedIndex >= displayModel.count) root.selectedIndex = displayModel.count - 1
    if (root.selectedIndex < 0) root.selectedIndex = 0
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    root.fetchMtimes()
  }

  // Batch stat for mtimes across raw candidate items.
  function fetchMtimes() {
    if (root.rawItems.length === 0 || procStat.running) return
    var argv = ["stat", "-c", "%Y\t%n", "--"]
    var hasPaths = false
    var limit = Math.min(root.rawItems.length, 300)
    for (var i = 0; i < limit; i++) {
      var path = root.rawItems[i].path
      if (path && path.indexOf("http://") !== 0 && path.indexOf("https://") !== 0) {
        argv.push(path)
        hasPaths = true
      }
    }
    if (!hasPaths) return
    procStat.gen = root.searchGen
    procStat.command = argv
    procStat.running = true
  }

  function applyMtimes(map) {
    root.mtimesLoaded = true
    var now = Date.now()
    for (var k in map) {
      root.mtimesMap[k] = map[k]
    }
    for (var j = 0; j < root.rawItems.length; j++) {
      var it = root.rawItems[j]
      if (map[it.path] !== undefined) {
        it.mtimeMs = map[it.path]
      }
    }
    var ranked = Backend.rankResults(root.rawItems, root.filterText, root.displayLimit, root.home, root.sortMode)
    displayModel.clear()
    for (var i = 0; i < ranked.length; i++) {
      var ms = ranked[i].mtimeMs
      displayModel.append({
        path: ranked[i].path,
        name: ranked[i].name,
        dir: ranked[i].dir,
        icon: ranked[i].icon,
        isDir: ranked[i].isDir,
        mtimeMs: ms !== undefined ? ms : 0,
        mtime: ms ? Backend.formatMtime(ms, now, root.locale) : ""
      })
    }
    if (root.selectedIndex >= displayModel.count) root.selectedIndex = displayModel.count - 1
    if (root.selectedIndex < 0) root.selectedIndex = 0
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  function setSortMode(mode) {
    root.sortMode = mode
    root.sortMenuOpen = false
    root.presentResults(root.rawItems)
  }

  function cycleSortMode() {
    var modes = Backend.SORT_MODES
    var idx = 0
    for (var i = 0; i < modes.length; i++) {
      if (modes[i].id === root.sortMode) { idx = i; break }
    }
    var nextIdx = (idx + 1) % modes.length
    root.setSortMode(modes[nextIdx].id)
  }

  function select(delta) {
    if (displayModel.count === 0) return
    root.selectedIndex = (root.selectedIndex + delta + displayModel.count) % displayModel.count
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  function selectPage(delta) {
    if (displayModel.count === 0) return
    var visibleRows = Math.max(1, Math.floor(resultList.height / root.rowHeight))
    var next = root.selectedIndex + delta * visibleRows
    if (next < 0) next = 0
    if (next >= displayModel.count) next = displayModel.count - 1
    root.selectedIndex = next
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  // Prefer gio open (which honors Terminal=true .desktop entries, launching
  // TUI apps like nvim inside the user's configured terminal emulator) over
  // xdg-open, which always execs the target command directly and silently
  // fails for terminal-based apps. Falls back to xdg-open if gio is absent.
  function openPath(path) {
    var quoted = Util.shellQuote(path)
    Quickshell.execDetached(["bash", "-lc",
      "command -v gio >/dev/null 2>&1 && exec gio open " + quoted + " || exec xdg-open " + quoted])
  }

  function activateIndex(index) {
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    if (!root.isAiMode) root.dismiss()
    root.openPath(row.path)
  }

  function openEnclosingFolder(index) {
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    root.dismiss()
    var target = row.isDir ? row.path : (row.path.slice(0, row.path.lastIndexOf("/")) || root.home)
    root.openPath(target)
  }

  function copyPathToClipboard(index) {
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    root.dismiss()
    Quickshell.execDetached(["wl-copy", row.path])
  }

  function openInTerminal(index) {
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    root.dismiss()
    var target = row.isDir ? row.path : (row.path.slice(0, row.path.lastIndexOf("/")) || root.home)
    Quickshell.execDetached(["bash", "-lc", "cd " + Util.shellQuote(target) + " && (xdg-terminal-exec || omarchy-default-terminal || $TERMINAL || kitty || foot || alacritty)"])
  }

  // AI search mode ---------------------------------------------------------
  //
  // Everything below only ever forwards raw process I/O into AiBackend.js
  // and re-renders whatever snapshot it hands back into root.aiSession.
  // This file never inspects adapterId/agentLabel to branch on which CLI is
  // active — that logic lives entirely behind the adapter interface.

  // Called on every load, hot-reload (create/edit/delete — see
  // aiConfigFile below), and watchdog firing. Config changes apply to
  // runtime state immediately (chip label, prefix, drain pacing, binary
  // re-check); an ALREADY-RUNNING generation is untouched — AiBackend
  // freezes session.config at beginGeneration() time (see AiBackend.js),
  // so a live reload here only ever affects the NEXT submit/resume, never
  // an in-flight one.
  function applyAiConfig(rawText) {
    if (root.aiConfigLoaded && rawText === root.aiConfigLastRawText) return // unchanged — no-op
    root.aiConfigLastRawText = rawText
    var omarchyAgent = omarchyAgentFile.text ? omarchyAgentFile.text().trim() : ""
    var result = AiBackend.loadConfig(rawText, omarchyAgent)
    root.aiConfigLoaded = true
    root.aiConfigWarning = result.warning || ""
    var cfg = AiBackend.getConfig()
    root.aiPrefix = cfg.prefix
    root.aiStreamFlushMs = cfg.streamFlushMs
    root.aiMaxAnswerRows = cfg.maxAnswerRows
    if (root.isAiMode) {
      root.aiSession = AiBackend.snapshot()
      root.ensureAiBinaryChecked()
    }
  }

  // aiBinaryCheck is a single shared Process, same reuse-while-running
  // hazard as the generation processes (QA P1-9) — never reassign it while
  // it's still running; if the target binary changed mid-check, its own
  // onExited re-issues for whatever is current once the slot is genuinely
  // free, instead of us racing a new command onto it here.
  function ensureAiBinaryChecked() {
    var disp = AiBackend.agentDisplay()
    if (!disp.supported) {
      root.aiBinaryChecked = true
      root.aiBinaryMissing = true
      return
    }
    root.aiBinaryCheckedFor = disp.binary
    if (root.aiBinaryChecked && aiBinaryCheck.checkingFor === disp.binary) return
    if (aiBinaryCheck.running) return
    root.aiBinaryChecked = false
    aiBinaryCheck.checkingFor = disp.binary
    aiBinaryCheck.command = ["which", disp.binary]
    aiBinaryCheck.running = true
  }

  function aiKillProcessIfRunning(proc, fallbackTimer) {
    if (!proc.running) return
    var pid = proc.processId
    proc.running = false
    if (pid) {
      Quickshell.execDetached(AiBackend.killArgv(pid, "TERM"))
      fallbackTimer.targetPid = pid
      fallbackTimer.restart()
    }
  }

  // Which of the two ping-pong Process slots (if any) a new command may be
  // assigned to right now — see AiBackend.pickFreeSlot's comment for why
  // this check is mandatory and not optional. Returns the Process itself,
  // or null if both are still tearing down a previous OS process.
  //
  // LATENT INVARIANT — read before touching either caller of this function:
  // `proc.running === false` only means "safe to retag" because the ONLY
  // two call sites that ever act on it are (a) aiSubmit(), driven by a key
  // press, and (b) the Qt.callLater(aiTryDispatchPending) queued from each
  // Process's own onExited. Both run OUTSIDE that Process's own onFinished
  // C++ callstack. If a future change ever calls aiDispatchOrQueue() or
  // aiTryDispatchPending() synchronously and reentrantly from INSIDE a
  // stdout/session-change handler (e.g. a future onAiLine()-driven auto-
  // submit), `running` reading false at that exact instant is not
  // sufficient proof the OLD OS process has actually finished dying — this
  // would resurrect the exact P0-1 blocker (a slot's `.gen` getting
  // overwritten while its previous incarnation is still tearing down). Keep
  // every dispatch on this pair either key/user-driven or behind
  // Qt.callLater from that Process's own exit.
  function aiFreeProc() {
    var slot = AiBackend.pickFreeSlot(aiProcA.running, aiProcB.running)
    return slot === "A" ? aiProcA : (slot === "B" ? aiProcB : null)
  }

  // Assigns argv to a free slot immediately, or queues it if both slots are
  // still busy (QA P0-1) — NEVER touches a Process whose `running` is true.
  function aiDispatchOrQueue(generation, argv) {
    var proc = root.aiFreeProc()
    if (!proc) {
      root.aiPendingSpawn = { generation: generation, argv: argv }
      return
    }
    root.aiPendingSpawn = null
    proc.gen = generation
    // Quickshell 0.3.0 quirk: with stdinEnabled=false (the default) it calls
    // closeWriteChannel() BEFORE QProcess::start(), where Qt ignores it — so
    // the child inherits a forever-open stdin pipe. codex exec waits for
    // stdin EOF before emitting anything and hangs indefinitely. Workaround:
    // spawn with stdin enabled, then flip it off in onStarted, where the
    // setter closes the live process's write channel and the child sees EOF.
    proc.stdinEnabled = true
    proc.command = argv
    proc.running = true
  }

  // Called from both aiProcA/aiProcB's onExited (deferred via Qt.callLater
  // so this never runs nested inside the just-finished process's own C++
  // exit handling — see AiBackend.pickFreeSlot). Drains the queue by at
  // most one entry since only one slot can have just freed up.
  function aiTryDispatchPending() {
    if (!root.aiPendingSpawn) return
    var proc = root.aiFreeProc()
    if (!proc) return
    var pending = root.aiPendingSpawn
    root.aiPendingSpawn = null
    proc.gen = pending.generation
    proc.stdinEnabled = true // see aiDispatchOrQueue — closed again in onStarted
    proc.command = pending.argv
    proc.running = true
  }

  // Full teardown: kill any in-flight generation, drop anything queued, and
  // (by default) invalidate any in-flight terminal handoff (QA P0-4) so its
  // callbacks can't act on state that's no longer current. Returns AI mode
  // to idle. invalidateHandoff defaults to true for every real caller
  // (Esc, prompt-edit-away, aiSubmit(), explicit close/dismiss) — pass
  // false ONLY when this cancel is itself a side effect of the very handoff
  // attempt concluding (see dismiss()'s preserveHandoffAttempt), never for
  // a genuine "user did something else" cancel.
  function aiCancel(invalidateHandoff) {
    root.aiPendingSpawn = null
    root.aiKillProcessIfRunning(aiProcA, aiKillFallbackTimerA)
    root.aiKillProcessIfRunning(aiProcB, aiKillFallbackTimerB)
    if (invalidateHandoff !== false) root.aiHandoffAttempt++
    aiHandoffGrace.stop()
    AiBackend.cancel()
  }

  function aiSubmit() {
    if (!root.isAiMode || root.aiBinaryMissing) return
    var prompt = root.aiPromptText.trim()
    if (prompt.length === 0) return
    root.aiCancel()
    var result = AiBackend.beginGeneration(prompt)
    root.aiSession = AiBackend.snapshot()
    root.aiHandoffError = ""
    if (!result.argv) return // unsupported-agent config error, already reflected above
    root.aiDispatchOrQueue(result.generation, result.argv)
  }

  function onAiLine(gen, line) {
    var snap = AiBackend.handleLine(gen, line)
    if (snap) root.aiSession = snap
  }

  function onAiStderr(gen, line) {
    AiBackend.handleStderrChunk(gen, line + "\n")
  }

  function onAiExit(gen, exitCode) {
    var snap = AiBackend.handleExit(gen, exitCode)
    if (snap) root.aiSession = snap
  }

  function aiCopyAnswer() {
    if (!root.aiSession || root.aiSession.state === "idle" || !root.aiSession.rawText) return
    Quickshell.execDetached(["wl-copy", root.aiSession.rawText])
  }

  // Ready -> resume the finished session in a terminal; but if the visible
  // prompt no longer matches what was actually submitted, Enter should ask
  // the NEW question instead of silently resuming the OLD answer (QA P1-11).
  function aiPromptChangedSinceSubmit() {
    var s = root.aiSession
    return !!(s && typeof s.prompt === "string" && s.prompt.length > 0 && root.aiPromptText.trim() !== s.prompt)
  }

  // Whether Enter should actually re-ask right now — a changed-but-EMPTY
  // prompt (box cleared, not replaced) has nothing submittable, so it falls
  // back to resuming the old session instead of both the footer promising a
  // re-ask AND Enter silently doing nothing (aiSubmit() itself no-ops on an
  // empty prompt) — this was previously inconsistent (QA round-3 nit).
  function aiCanReask() {
    return root.aiPromptChangedSinceSubmit() && root.aiPromptText.trim().length > 0
  }

  function aiHandoff() {
    if (!root.aiSession || root.aiSession.state !== "ready" || !root.aiSession.canHandoff) return
    if (root.aiCanReask()) { root.aiSubmit(); return }
    var resumeArgv = AiBackend.buildHandoffArgv()
    if (!resumeArgv) return
    // beginHandoff() flips state to "handoff" so a second Enter (or key
    // auto-repeat) can never dispatch a second terminal onto this session
    // (QA P0-3) — the Enter handler only calls aiHandoff() while state is
    // still "ready", and this is the only place that leaves "ready".
    var snap = AiBackend.beginHandoff()
    if (!snap) return
    root.aiSession = snap
    root.aiHandoffError = ""
    root.aiHandoffAttempt++
    aiHandoffProcess.attempt = root.aiHandoffAttempt
    aiHandoffProcess.resumeArgv = resumeArgv
    aiHandoffProcess.handled = false
    // xdg-terminal-exec only accepts the equals form for option values
    // ("--dir=DIR"); the space form makes it treat DIR as the command.
    aiHandoffProcess.command = ["xdg-terminal-exec", "--dir=" + root.home, "--"].concat(resumeArgv)
    aiHandoffProcess.running = true
    aiHandoffGrace.restart()
  }

  // Presentation-only formatting (plan §14) — every field read below
  // (agentLabel, modelLabel, activity, state) is already fully resolved by
  // AiBackend/the adapter; nothing here ever compares against an agent id.
  function aiChipText() {
    var s = root.aiSession
    if (!s) return "AI"
    var parts = ["AI", s.agentLabel]
    if (s.modelLabel) parts.push(s.modelLabel)
    var text = parts.join(" · ")
    if (root.aiBinaryMissing) text += " · not installed"
    else if (s.state === "starting") text += " · starting…"
    else if (s.state === "running") text += (s.activity === "searching" ? " · searching…" : " · thinking…")
    // Draining means the process already exited — the answer is fully known
    // and just finishing its (accelerated, see AiBackend.tick) typewriter
    // animation. "thinking…" here was misleading (QA P0-7).
    else if (s.state === "draining") text += " · finishing…"
    else if (s.state === "handoff") text += " · opening terminal…"
    else if (s.state === "error") text += " · error"
    return text
  }

  function aiFooterText() {
    var s = root.aiSession
    var state = s ? s.state : "idle"
    var hint
    if (state === "ready") {
      if (root.aiCanReask()) {
        hint = "Enter ask new question · Esc close"
      } else {
        hint = (s && s.canHandoff) ? "↵ continue in terminal · Ctrl+C copy · Esc close" : "Ctrl+C copy · Esc close (no session to resume)"
      }
    } else if (state === "handoff") {
      hint = "Opening terminal…"
    } else if (state === "error") {
      hint = "Enter retry · Esc close"
    } else if (state === "starting" || state === "running" || state === "draining") {
      hint = "Esc cancel"
    } else if (root.aiBinaryMissing) {
      hint = "CLI not found on PATH · Esc close"
    } else {
      hint = "Enter ask · Esc close"
    }
    if (root.aiHandoffError) hint += "\n" + root.aiHandoffError
    return hint
  }

  ListModel { id: displayModel }

  Timer {
    id: debounce
    interval: 200
    onTriggered: root.runSearch()
  }

  Process {
    id: procDirs
    property int gen: 0
    property string kind: "d"
    stdout: StdioCollector {
      id: outDirs
      waitForEnd: true
    }
    onExited: function(exitCode) { root.procFinished(procDirs, outDirs.text || "") }
  }

  Process {
    id: procFiles
    property int gen: 0
    property string kind: "f"
    stdout: StdioCollector {
      id: outFiles
      waitForEnd: true
    }
    onExited: function(exitCode) { root.procFinished(procFiles, outFiles.text || "") }
  }

  Process {
    id: procStat
    property int gen: 0
    stdout: StdioCollector {
      id: outStat
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (procStat.gen !== root.searchGen) {
        // Obsolete search result.
        if (!root.mtimesLoaded) root.fetchMtimes()
        return
      }
      root.applyMtimes(Backend.parseStatLines(outStat.text || ""))
    }
  }

  // AI search mode — config, binary check, the two generation processes,
  // the display-drain timer, and terminal handoff. See ai/AiBackend.js for
  // the state machine these merely feed raw OS events into.

  // ~/.config/omarchy-find/ai.json is optional and NEVER created/rewritten
  // by this plugin (plan §6) — a missing file just means built-in defaults,
  // exactly like the FileView-backed optional config files elsewhere in
  // this shell (see Style.qml's windowNoGapsToggle/userShellFile).
  //
  // Hot reload (create/edit/delete, all live): watchChanges alone only
  // arms Quickshell's underlying QFileSystemWatcher — per
  // quickshell/src/io/fileview.cpp's updateWatchedFiles()/
  // onWatchedDirectoryChanged(), it watches BOTH the target file AND its
  // parent directory, so file creation while previously absent is natively
  // detected too (the directory watch notices the new entry, confirms the
  // file now exists, and emits fileChanged() — no polling needed for that
  // case). But watchChanges alone does NOT re-read content — text() stays
  // stale until something calls reload(); onFileChanged: reload() is the
  // missing half (this exact two-part pattern already exists for
  // userShellFile in Style.qml). reload() itself routes back through
  // onLoaded (edit, or create) / onLoadFailed (delete) with fresh content
  // either way. aiConfigWatchdog below is a cheap belt-and-suspenders
  // fallback only for the one native gap: if ~/.config/omarchy-find/ itself
  // doesn't exist yet at shell startup, there's no directory to watch until
  // something creates it — a rare edge case (creating ai.json normally
  // creates its parent dir too), but a periodic reload() is a negligible-
  // cost small local file stat, and applyAiConfig()'s own content-equality
  // guard makes every redundant firing a genuine no-op.
  FileView {
    id: aiConfigFile
    path: root.home + "/.config/omarchy-find/ai.json"
    watchChanges: true
    printErrors: false
    onLoaded: root.applyAiConfig(text())
    onLoadFailed: root.applyAiConfig(null)
    onFileChanged: reload()
  }

  // Reads ~/.config/omarchy/defaults/agent — the user's Omarchy-wide default
  // AI agent — and passes it to applyAiConfig() as a fallback when ai.json
  // does not specify an agent. Hot-reloaded automatically if the user switches
  // their Omarchy agent while the overlay is open (unlikely but free).
  FileView {
    id: omarchyAgentFile
    path: root.home + "/.config/omarchy/defaults/agent"
    watchChanges: true
    printErrors: false
    onLoaded: root.applyAiConfig(aiConfigFile.text ? aiConfigFile.text() : null)
    onLoadFailed: root.applyAiConfig(aiConfigFile.text ? aiConfigFile.text() : null)
    onFileChanged: reload()
  }

  Timer {
    id: aiConfigWatchdog
    interval: 5000
    repeat: true
    running: true
    onTriggered: aiConfigFile.reload()
  }

  // Single shared `which` check. checkingFor + the reuse guard in
  // ensureAiBinaryChecked() avoid the exact same reuse-while-running hazard
  // as the generation processes below (QA P1-9): never reassign this
  // Process while it's still running for a different binary; instead
  // re-issue for whatever's current once its own exit confirms it's free.
  Process {
    id: aiBinaryCheck
    property string checkingFor: ""
    stdout: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (aiBinaryCheck.checkingFor === root.aiBinaryCheckedFor) {
        root.aiBinaryMissing = (exitCode !== 0)
        root.aiBinaryChecked = true
      } else {
        // Deferred to the next event-loop turn for the same reason as
        // aiProcA/aiProcB's Qt.callLater(aiTryDispatchPending) — don't touch
        // command/running while still nested inside this Process's own exit
        // handling.
        Qt.callLater(root.ensureAiBinaryChecked)
      }
    }
  }

  // Two Process elements alternate per generation (ping-pong) instead of
  // reusing one — but the ping-pong alone is NOT sufficient by itself: a
  // rapid submit/cancel/submit/cancel/submit sequence can still cycle back
  // to a slot whose OS process from an earlier generation hasn't actually
  // died yet (Quickshell fact: running stays true until the OS process is
  // genuinely gone, regardless of running=false having been set to request
  // termination — see AiBackend.pickFreeSlot's comment). aiDispatchOrQueue/
  // aiTryDispatchPending are therefore the ONLY code paths allowed to touch
  // command+running on these two Processes; nothing else may. Which
  // generation a callback belongs to is carried by `.gen` and re-validated
  // inside AiBackend (isStale), never inferred from which Process fired.
  Process {
    id: aiProcA
    property int gen: 0
    // Closes the child's stdin (EOF) — see the comment in aiDispatchOrQueue.
    onStarted: aiProcA.stdinEnabled = false
    stdout: SplitParser { onRead: function(line) { root.onAiLine(aiProcA.gen, line) } }
    stderr: SplitParser { onRead: function(line) { root.onAiStderr(aiProcA.gen, line) } }
    onExited: function(exitCode) {
      aiKillFallbackTimerA.stop()
      aiKillFallbackTimerA.targetPid = null
      root.onAiExit(aiProcA.gen, exitCode)
      // Deferred to the next event-loop turn so this never runs nested
      // inside aiProcA's own C++ exit handling (see AiBackend.pickFreeSlot).
      Qt.callLater(root.aiTryDispatchPending)
    }
  }

  Process {
    id: aiProcB
    property int gen: 0
    // Closes the child's stdin (EOF) — see the comment in aiDispatchOrQueue.
    onStarted: aiProcB.stdinEnabled = false
    stdout: SplitParser { onRead: function(line) { root.onAiLine(aiProcB.gen, line) } }
    stderr: SplitParser { onRead: function(line) { root.onAiStderr(aiProcB.gen, line) } }
    onExited: function(exitCode) {
      aiKillFallbackTimerB.stop()
      aiKillFallbackTimerB.targetPid = null
      root.onAiExit(aiProcB.gen, exitCode)
      Qt.callLater(root.aiTryDispatchPending)
    }
  }

  // Belt-and-suspenders process-group cleanup: aiKillProcessIfRunning()
  // already sent SIGTERM to the whole group (agent CLI is spawned via
  // setsid so it's its own process-group leader — see AiBackend.wrapForGroup)
  // the instant a generation is cancelled. If anything in that group is
  // still alive shortly after, escalate to SIGKILL. One timer PER slot (not
  // shared) — a shared single-pid timer would let a rapid cancel of BOTH
  // slots silently drop one of the two escalations (QA P0-2). Each timer is
  // stopped by its own Process's onExited once the real death is confirmed,
  // so a clean exit never leaves a stray delayed kill -KILL armed.
  Timer {
    id: aiKillFallbackTimerA
    property var targetPid: null
    interval: 500
    repeat: false
    onTriggered: {
      if (aiKillFallbackTimerA.targetPid) {
        Quickshell.execDetached(AiBackend.killArgv(aiKillFallbackTimerA.targetPid, "KILL"))
        aiKillFallbackTimerA.targetPid = null
      }
    }
  }

  Timer {
    id: aiKillFallbackTimerB
    property var targetPid: null
    interval: 500
    repeat: false
    onTriggered: {
      if (aiKillFallbackTimerB.targetPid) {
        Quickshell.execDetached(AiBackend.killArgv(aiKillFallbackTimerB.targetPid, "KILL"))
        aiKillFallbackTimerB.targetPid = null
      }
    }
  }

  // Paced display drain (plan §17). Ticks at ~60Hz (16ms) by default so the
  // ramped-typewriter reveal in AiBackend.tick() reads as continuous/smooth
  // rather than the old 20Hz two-regime formula's visible chunky steps —
  // measured offline (qml6 -platform offscreen QQuickText benchmark, not
  // the live shell) that a 500+ word wrapped answer relayouts in ~1ms worst
  // case per update, so 60Hz has no perf headroom problem here. Runs only
  // while there's streaming to normalize; AiBackend.tick() returns null on
  // an idle tick (nothing pending or revealed, nothing transitioned) so
  // this only reassigns root.aiSession — and only then triggers a Text
  // re-render — on ticks that actually revealed something.
  Timer {
    id: aiDrainTimer
    interval: Math.max(8, root.aiStreamFlushMs)
    repeat: true
    running: !!(root.aiSession && (root.aiSession.state === "running" || root.aiSession.state === "draining"))
    onTriggered: {
      var snap = AiBackend.tick()
      if (snap) root.aiSession = snap
    }
  }

  // Terminal handoff (plan §21). xdg-terminal-exec's own `-- command args...`
  // form spawns the resume command argv-safe end to end — no shell string
  // ever holds the session id. `handled` lets either the exit signal or the
  // grace timer make the launched/failed decision exactly once; `attempt`
  // (compared against root.aiHandoffAttempt, bumped by aiCancel()) stops a
  // callback from a handoff the user has since moved away from touching
  // unrelated later state (QA P0-4) — e.g. it must never call root.dismiss()
  // over a follow-on search/question the user already started typing.
  Process {
    id: aiHandoffProcess
    property bool handled: true
    property int attempt: 0
    property var resumeArgv: null
    stderr: StdioCollector { id: aiHandoffStderr; waitForEnd: false }
    onExited: function(exitCode) {
      var alreadyHandled = aiHandoffProcess.handled
      aiHandoffProcess.handled = true
      aiHandoffGrace.stop()
      var superseded = aiHandoffProcess.attempt !== root.aiHandoffAttempt
      if (exitCode === 0) {
        if (!alreadyHandled && !superseded) root.dismiss()
        return
      }
      // Non-zero exit — always log (plan §19: log raw output even when
      // unclassified), since this may be the ONLY failure signal we ever
      // get if the grace timer already fired first.
      console.warn("[omarchy-find/ai] terminal handoff failed (exit " + exitCode + "): " + (aiHandoffStderr.text || "(no stderr)"))
      if (superseded) return // aiCancel() already moved on — don't touch unrelated state
      if (!alreadyHandled) {
        // Still within the interactive window: the overlay and session are
        // intact — show the error and let Enter be tried again (QA P0-6).
        root.aiHandoffError = "Could not open a terminal — try again or check your default terminal setup"
        var snap = AiBackend.cancelHandoff()
        if (snap) root.aiSession = snap
      } else if (aiHandoffProcess.resumeArgv) {
        // Grace already declared success and closed the overlay — there is
        // no UI left to show an error in (plan §21 can't be honored
        // post-hoc). Surface it loudly instead of losing it silently.
        Quickshell.execDetached(["notify-send", "Omarchy Find",
          "Terminal failed to open — resume manually: " + aiHandoffProcess.resumeArgv.join(" ")])
      }
    }
  }

  Timer {
    id: aiHandoffGrace
    interval: 400
    repeat: false
    onTriggered: {
      if (aiHandoffProcess.handled) return
      aiHandoffProcess.handled = true
      if (aiHandoffProcess.attempt !== root.aiHandoffAttempt) return
      // Still running after the grace window: the terminal launched fine
      // (whether xdg-terminal-exec exec'd in place or forked and is
      // waiting) — plan §21: never discard a working session over this.
      // preserveHandoffAttempt=true: this dismiss is not a user cancelling
      // anything, it's THIS SAME attempt optimistically concluding — the OS
      // process may still be alive and may still fail. A late failure after
      // this point is still caught by aiHandoffProcess.onExited's
      // alreadyHandled/notify-send branch above, but only because the
      // attempt token survives this specific dismiss (see dismiss()'s doc).
      root.dismiss(true)
    }
  }

  // Known gap: Quickshell's Process exposes no error/failure signal for
  // QProcess::FailedToStart (e.g. xdg-terminal-exec missing entirely) —
  // only started/exited(exitCode, exitStatus) and property-change signals
  // are in Quickshell.Io's qmltypes; `onExited` never fires for a process
  // that never started. That specific failure mode is therefore silent
  // (grace still fires and dismisses after 400ms; no console.warn, no
  // notify-send) — undetectable from QML with the primitives available
  // here, not something this fix can close.

  // UI

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-find"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: root.expanded
        ? (root.isGoogleSearch
            ? (root.googleSearchTerms !== ""
                ? (root.headerHeight + root.rowHeight + footer.implicitHeight + root.contentSpacing * 2 + card.contentTopInset + card.contentBottomInset)
                : (root.headerHeight + card.contentTopInset + card.contentBottomInset))
            : root.isAiMode
              ? (root.aiSession && root.aiSession.state !== "idle"
                  ? (root.headerHeight + root.aiChipRowHeight + root.aiAnswerMaxHeight + footer.implicitHeight + root.contentSpacing * 3 + card.contentTopInset + card.contentBottomInset)
                  : (root.headerHeight + root.aiChipRowHeight + footer.implicitHeight + root.contentSpacing * 2 + card.contentTopInset + card.contentBottomInset))
              : root.cardHeight)
        : root.headerHeight + card.contentTopInset + card.contentBottomInset
      radius: root.cornerRadius
      anchors.centerIn: parent

      Behavior on height {
        NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
      }

      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape) {
            if (root.sortMenuOpen) {
              root.sortMenuOpen = false
            } else if (root.filterText) {
              root.setFilter("")
            } else {
              root.dismiss()
            }
            event.accepted = true
          } else if (event.modifiers & Qt.ControlModifier && event.key === Qt.Key_S) {
            root.cycleSortMode()
            event.accepted = true
          } else if (event.modifiers & Qt.ControlModifier && event.key === Qt.Key_L) {
            root.cycleDisplayLimit()
            event.accepted = true
          } else if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && (event.modifiers & Qt.ShiftModifier))) {
            if (root.switchPanel(-1)) {
              event.accepted = true
            } else if (root.expanded && !root.isAiMode) {
              root.cycleFilter(-1)
              event.accepted = true
            } else {
              event.accepted = true
            }
          } else if (event.key === Qt.Key_Tab) {
            if (root.isGoogleSearch || root.isAiMode) {
              event.accepted = true
            } else if (root.expanded && root.filterText.trim() !== "") {
              root.cycleFilter(1)
              event.accepted = true
            } else if (!root.switchPanel(1)) {
              if (root.expanded) {
                root.cycleFilter(1)
              } else {
                root.expandForBrowse()
              }
              event.accepted = true
            } else {
              event.accepted = true
            }
          } else if (Util.editsFilter(event, root.filterText)) {
            root.setFilter(Util.editedFilter(event, root.filterText))
            event.accepted = true
          } else if (event.modifiers & Qt.ControlModifier && event.key === Qt.Key_W) {
            root.setFilter(root.filterText.replace(/\s+$/, "").replace(/\S+$/, ""))
            event.accepted = true
          } else if (event.modifiers & Qt.ControlModifier && event.key === Qt.Key_C) {
            if (root.isAiMode) root.aiCopyAnswer()
            else root.copyPathToClipboard(root.selectedIndex)
            event.accepted = true
          } else if (event.modifiers & Qt.ControlModifier && event.key === Qt.Key_T) {
            if (!root.isAiMode) root.openInTerminal(root.selectedIndex)
            event.accepted = true
          } else if (event.key === Qt.Key_Up || (event.modifiers & Qt.ControlModifier && (event.key === Qt.Key_P || event.key === Qt.Key_K))) {
            root.select(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_Down || (event.modifiers & Qt.ControlModifier && (event.key === Qt.Key_N || event.key === Qt.Key_J))) {
            root.select(1)
            event.accepted = true
          } else if (event.key === Qt.Key_PageUp) {
            root.selectPage(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_PageDown) {
            root.selectPage(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Home) {
            if (displayModel.count > 0) {
              root.selectedIndex = 0
              resultList.positionViewAtIndex(0, ListView.Contain)
            }
            event.accepted = true
          } else if (event.key === Qt.Key_End) {
            if (displayModel.count > 0) {
              root.selectedIndex = displayModel.count - 1
              resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
            }
            event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            if (root.isAiMode) {
              // Key auto-repeat (held Enter) must never re-trigger submit/
              // handoff — ignored outright rather than just deduped, since a
              // repeat-fired submit while already Ready would otherwise
              // restart a perfectly good finished answer (QA P0-3).
              if (!event.isAutoRepeat) {
                // Enter's meaning depends on the AiSession state (plan §5):
                // idle/error -> submit (retry re-submits the same prompt);
                // starting/running/draining/handoff -> no-op; ready ->
                // terminal handoff (or a fresh submit if the prompt was
                // edited since — see aiHandoff()'s own guard, QA P1-11).
                var aiState = root.aiSession ? root.aiSession.state : "idle"
                if (aiState === "idle" || aiState === "error") root.aiSubmit()
                else if (aiState === "ready") root.aiHandoff()
              }
            } else if (event.modifiers & Qt.AltModifier) {
              root.openEnclosingFolder(root.selectedIndex)
            } else {
              root.activateIndex(root.selectedIndex)
            }
            event.accepted = true
          } else if (event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127 && (event.modifiers === Qt.NoModifier || event.modifiers === Qt.ShiftModifier)) {
            root.setFilter(root.filterText + event.text)
            event.accepted = true
          }
        }
      }

      Column {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: root.contentSpacing

        Rectangle {
          id: searchField
          width: parent.width
          height: root.headerHeight
          radius: root.cornerRadius
          color: "transparent"

          Text {
            id: searchIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "󰍉"
            textFormat: Text.PlainText
            color: root.accent
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
          }

          Text {
            anchors.left: searchIcon.right
            anchors.leftMargin: Style.spacing.sm
            anchors.right: expandButton.left
            anchors.rightMargin: Style.spacing.sm
            anchors.verticalCenter: parent.verticalCenter
            text: root.filterText || Backend.t("searchPlaceholder", root.locale)
            textFormat: Text.PlainText
            color: root.foreground
            opacity: root.filterText ? 1 : 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }

          Rectangle {
            id: expandButton
            visible: !root.isGoogleSearch && !root.isAiMode
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: expandLabel.implicitWidth + Style.space(18)
            height: Math.max(Style.space(26), Style.font.body + Style.space(10))
            radius: root.cornerRadius
            color: expandMouse.containsMouse ? root.chipHover : root.chipIdle

            Text {
              id: expandLabel
              anchors.centerIn: parent
              text: Backend.t(root.expanded ? "collapse" : "expand", root.locale)
              textFormat: Text.PlainText
              color: root.expanded ? root.foreground : root.accent
              opacity: root.expanded ? 0.8 : 1
              font.family: root.fontFamily
              font.pixelSize: Math.max(10, Style.font.body - 1)
            }

            MouseArea {
              id: expandMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.expanded ? root.collapseView() : root.expandForBrowse()
            }
          }
        }

        Flickable {
          id: chips
          visible: root.expanded && !root.isGoogleSearch && !root.isAiMode
          width: parent.width
          height: chipRow.height
          contentWidth: chipRow.width
          clip: true
          interactive: contentWidth > width
          boundsBehavior: Flickable.StopAtBounds

          Row {
            id: chipRow
            spacing: Style.spacing.xs

            Repeater {
              model: Backend.FILTERS

              delegate: Rectangle {
                id: chip
                required property int index
                required property var modelData
                readonly property bool activeChip: index === root.activeFilter

                height: Math.max(Style.space(26), Style.font.body + Style.space(10))
                width: chipLabel.implicitWidth + Style.space(18)
                radius: root.cornerRadius
                color: chip.activeChip
                  ? root.chipActive
                  : (chipMouse.containsMouse ? root.chipHover : root.chipIdle)

                Text {
                  id: chipLabel
                  anchors.centerIn: parent
                  text: Backend.t(chip.modelData.id, root.locale)
                  textFormat: Text.PlainText
                  color: chip.activeChip ? root.accent : root.foreground
                  opacity: chip.activeChip ? 1 : 0.8
                  font.family: root.fontFamily
                  font.pixelSize: Math.max(10, Style.font.body - 1)
                }

                MouseArea {
                  id: chipMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.setActiveFilter(chip.index)
                }
              }
            }
          }
        }

        Row {
          id: sortBar
          visible: root.expanded && !root.isGoogleSearch && !root.isAiMode
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.spacing.xs

          Repeater {
            model: Backend.SORT_MODES

            delegate: Row {
              id: sortItem
              required property int index
              required property var modelData
              readonly property bool isSelected: sortItem.modelData.id === root.sortMode

              spacing: Style.spacing.xs

              Text {
                visible: sortItem.index > 0
                anchors.verticalCenter: parent.verticalCenter
                text: "·"
                textFormat: Text.PlainText
                color: root.foreground
                opacity: 0.35
                font.family: root.fontFamily
                font.pixelSize: Math.max(10, Style.font.body - 2)
              }

              Text {
                id: sortLabel
                anchors.verticalCenter: parent.verticalCenter
                text: Backend.t(sortItem.modelData.labelKey, root.locale)
                textFormat: Text.PlainText
                color: sortItem.isSelected ? root.accent : root.foreground
                opacity: sortItem.isSelected ? 1 : (sortMouse.containsMouse ? 0.9 : 0.45)
                font.family: root.fontFamily
                font.pixelSize: Math.max(10, Style.font.body - 2)
                font.weight: sortItem.isSelected ? Font.DemiBold : Font.Normal

                MouseArea {
                  id: sortMouse
                  anchors.fill: parent
                  anchors.margins: -4
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.setSortMode(sortItem.modelData.id)
                }
              }
            }
          }
        }

        // AI mode — status chip + streaming answer panel. Nothing below
        // branches on which agent is configured: agentLabel/modelLabel/
        // activity/state are already fully resolved on root.aiSession by
        // AiBackend.js and aiChipText()/aiFooterText() above (plan §2's
        // "QML renders truth" rule).
        Item {
          id: aiPanel
          visible: root.expanded && root.isAiMode
          width: parent.width
          height: (root.aiSession && root.aiSession.state !== "idle")
            ? (root.aiChipRowHeight + root.contentSpacing + root.aiAnswerMaxHeight)
            : root.aiChipRowHeight

          Row {
            id: aiChipRow
            height: root.aiChipRowHeight
            spacing: Style.spacing.sm

            Rectangle {
              anchors.verticalCenter: parent.verticalCenter
              height: root.aiChipRowHeight
              width: aiChipLabel.implicitWidth + Style.space(18)
              radius: root.cornerRadius
              color: root.aiSession && root.aiSession.state === "error" ? Util.alpha(Color.urgent, 0.18) : root.chipActive

              Text {
                id: aiChipLabel
                anchors.centerIn: parent
                text: root.aiChipText()
                textFormat: Text.PlainText
                color: root.aiSession && root.aiSession.state === "error" ? Color.urgent : root.accent
                font.family: root.fontFamily
                font.pixelSize: Math.max(10, Style.font.body - 1)
              }
            }

            Text {
              visible: root.aiConfigWarning !== ""
              anchors.verticalCenter: parent.verticalCenter
              width: Math.max(0, aiPanel.width - aiChipLabel.implicitWidth - Style.space(40))
              text: root.aiConfigWarning
              textFormat: Text.PlainText
              color: root.foreground
              opacity: 0.55
              elide: Text.ElideRight
              font.family: root.fontFamily
              font.pixelSize: Math.max(9, Style.font.body - 3)
            }
          }

          Rectangle {
            id: aiAnswerBox
            visible: root.aiSession && root.aiSession.state !== "idle"
            anchors.top: aiChipRow.bottom
            anchors.topMargin: root.contentSpacing
            width: parent.width
            height: root.aiAnswerMaxHeight
            radius: root.cornerRadius
            color: root.chipIdle

            Flickable {
              id: aiAnswerFlick
              anchors.fill: parent
              anchors.margins: Style.spacing.sm
              clip: true
              contentWidth: width
              contentHeight: aiAnswerText.implicitHeight
              boundsBehavior: Flickable.StopAtBounds
              property bool pinnedToBottom: true

              // Programmatic contentY writes (the auto-scroll branch just
              // below) never toggle `moving`, so this only fires on genuine
              // user drag/flick — plan §17/§26.9's scroll-pin behavior.
              onContentHeightChanged: {
                if (aiAnswerFlick.pinnedToBottom)
                  aiAnswerFlick.contentY = Math.max(0, aiAnswerFlick.contentHeight - aiAnswerFlick.height)
              }
              onMovementEnded: {
                aiAnswerFlick.pinnedToBottom = aiAnswerFlick.contentY >= (aiAnswerFlick.contentHeight - aiAnswerFlick.height - 4)
              }

              Text {
                id: aiAnswerText
                width: aiAnswerFlick.width
                text: {
                  var s = root.aiSession
                  if (!s) return ""
                  if (s.state !== "error") return s.displayedText
                  // A mid-stream failure must not hide whatever the agent
                  // already said (setError() flushes pendingText into
                  // displayedText for exactly this) — show the retained
                  // partial answer with a clearly separated error line
                  // beneath it, not the error message alone.
                  var msg = s.errorMessage || ""
                  return s.displayedText && s.displayedText.length > 0
                    ? s.displayedText + "\n\n⚠ " + msg
                    : msg
                }
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                // Only redden the whole block when there's nothing but the
                // error to show — a retained partial answer should read as
                // an answer, with just the trailing "⚠ " line marking the
                // failure, not the entire thing as an error.
                color: (root.aiSession && root.aiSession.state === "error" &&
                        (!root.aiSession.displayedText || root.aiSession.displayedText.length === 0))
                  ? Color.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }
        }

        Item {
          visible: root.expanded && !root.isAiMode && (!root.isGoogleSearch || root.googleSearchTerms !== "")
          width: parent.width
          height: root.isGoogleSearch
            ? root.rowHeight
            : Math.max(0, parent.height - searchField.height - (chips.visible ? chips.height : 0) - (sortBar.visible ? sortBar.height : 0) - (countLabel.visible ? countLabel.implicitHeight : 0) - footer.implicitHeight - root.contentSpacing * (countLabel.visible ? 5 : 4))

          ListView {
            id: resultList
            anchors.fill: parent
            model: displayModel
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            delegate: Rectangle {
              id: rowRoot
              required property int index
              required property string path
              required property string name
              required property string dir
              required property string icon
              required property string mtime

              readonly property bool hasCursor: index === root.selectedIndex

              width: resultList.width
              height: root.rowHeight
              radius: root.cornerRadius
              color: hasCursor ? root.selectedBackground : "transparent"

              Rectangle {
                visible: rowRoot.hasCursor
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(3)
                height: parent.height - Style.space(14)
                radius: width / 2
                color: root.accent
              }

              Text {
                id: rowIcon
                anchors.left: parent.left
                anchors.leftMargin: Style.spacing.sm + Style.space(4)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(24)
                horizontalAlignment: Text.AlignHCenter
                text: rowRoot.icon
                textFormat: Text.PlainText
                color: rowRoot.hasCursor ? root.selectedText : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }

              Column {
                anchors.left: rowIcon.right
                anchors.leftMargin: Style.spacing.sm
                anchors.right: mtimeLabel.left
                anchors.rightMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter

                Text {
                  width: parent.width
                  text: rowRoot.name
                  textFormat: Text.PlainText
                  color: rowRoot.hasCursor ? root.selectedText : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  text: rowRoot.dir
                  textFormat: Text.PlainText
                  color: rowRoot.hasCursor ? root.selectedText : root.foreground
                  opacity: rowRoot.hasCursor ? 0.75 : 0.5
                  font.family: root.fontFamily
                  font.pixelSize: Math.max(10, Style.font.body - 3)
                  elide: Text.ElideMiddle
                }
              }

              Text {
                id: mtimeLabel
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.sm
                anchors.verticalCenter: parent.verticalCenter
                text: rowRoot.mtime
                textFormat: Text.PlainText
                color: rowRoot.hasCursor ? root.selectedText : root.foreground
                opacity: rowRoot.hasCursor ? 0.75 : 0.5
                font.family: root.fontFamily
                font.pixelSize: Math.max(10, Style.font.body - 3)
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.selectedIndex = rowRoot.index
                onClicked: {
                  root.selectedIndex = rowRoot.index
                  root.activateIndex(rowRoot.index)
                }
              }
            }
          }

          Column {
            anchors.centerIn: parent
            spacing: Style.space(8)
            visible: !root.isGoogleSearch && displayModel.count === 0

            Text {
              text: "󰈉"
              textFormat: Text.PlainText
              color: root.selectedText
              opacity: 0.8
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Text {
              text: root.searching
                ? Backend.t("searchingState", root.locale)
                : (root.filterText
                   ? Backend.t("noResults", root.locale) + root.filterText + "\""
                   : Backend.t("noRecent", root.locale))
              textFormat: Text.PlainText
              color: root.foreground
              opacity: 0.7
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }
          }
        }

        Text {
          id: countLabel
          visible: root.expanded && !root.isGoogleSearch && !root.isAiMode && (text !== "")
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.searching
            ? Backend.t("searching", root.locale)
            : (displayModel.count > 0
               ? displayModel.count + Backend.t(displayModel.count === 1 ? "result" : "results", root.locale) + " · " + Backend.t("maxLimit", root.locale) + ": " + root.displayLimit + " 󰅀"
               : "")
          textFormat: Text.PlainText
          color: countMouse.containsMouse ? root.foreground : root.accent
          opacity: countMouse.containsMouse ? 1.0 : 0.85
          font.family: root.fontFamily
          font.pixelSize: Math.max(10, Style.font.body - 1)

          MouseArea {
            id: countMouse
            anchors.fill: parent
            anchors.margins: -4
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.cycleDisplayLimit()
          }
        }

        Text {
          id: footer
          visible: root.expanded && (!root.isGoogleSearch || root.googleSearchTerms !== "")
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.isGoogleSearch
            ? Backend.t("googleFooter", root.locale)
            : root.isAiMode
              ? root.aiFooterText()
              : Backend.t("footer", root.locale)
          textFormat: Text.PlainText
          color: root.foreground
          opacity: 0.45
          font.family: root.fontFamily
          font.pixelSize: Math.max(10, Style.font.body - 2)
          lineHeight: 1.25
        }
      }
    }
  }
}
