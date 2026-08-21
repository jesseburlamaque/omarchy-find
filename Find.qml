import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "FindBackend.js" as Backend

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

  function dismiss() {
    root.cancelProcs()
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
    // Search only when expanded and not in Google search mode.
    if (!root.expanded || root.isGoogleSearch) return
    root.searchGen++
    root.cancelProcs()
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

  function activateIndex(index) {
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    root.dismiss()
    Quickshell.execDetached(["xdg-open", row.path])
  }

  function openEnclosingFolder(index) {
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    root.dismiss()
    var target = row.isDir ? row.path : (row.path.slice(0, row.path.lastIndexOf("/")) || root.home)
    Quickshell.execDetached(["xdg-open", target])
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
    Quickshell.execDetached(["bash", "-c", "cd " + Util.shellQuote(target) + " && (xdg-terminal-exec || omarchy-default-terminal || $TERMINAL || kitty || foot || alacritty)"])
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
            } else if (root.expanded) {
              root.cycleFilter(-1)
              event.accepted = true
            } else {
              event.accepted = true
            }
          } else if (event.key === Qt.Key_Tab) {
            if (root.isGoogleSearch) {
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
            root.copyPathToClipboard(root.selectedIndex)
            event.accepted = true
          } else if (event.modifiers & Qt.ControlModifier && event.key === Qt.Key_T) {
            root.openInTerminal(root.selectedIndex)
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
            if (event.modifiers & Qt.AltModifier) {
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
            color: root.foreground
            opacity: root.filterText ? 1 : 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }

          Rectangle {
            id: expandButton
            visible: !root.isGoogleSearch
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
          visible: root.expanded && !root.isGoogleSearch
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
          visible: root.expanded && !root.isGoogleSearch
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
                color: root.foreground
                opacity: 0.35
                font.family: root.fontFamily
                font.pixelSize: Math.max(10, Style.font.body - 2)
              }

              Text {
                id: sortLabel
                anchors.verticalCenter: parent.verticalCenter
                text: Backend.t(sortItem.modelData.labelKey, root.locale)
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

        Item {
          visible: root.expanded && (!root.isGoogleSearch || root.googleSearchTerms !== "")
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
                  color: rowRoot.hasCursor ? root.selectedText : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  text: rowRoot.dir
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
          visible: root.expanded && !root.isGoogleSearch && (text !== "")
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: root.searching
            ? Backend.t("searching", root.locale)
            : (displayModel.count > 0
               ? displayModel.count + Backend.t(displayModel.count === 1 ? "result" : "results", root.locale) + " · " + Backend.t("maxLimit", root.locale) + ": " + root.displayLimit + " 󰅀"
               : "")
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
            : Backend.t("footer", root.locale)
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
