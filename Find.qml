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
    root.filterText = query
    root.selectedIndex = 0
    root.activeFilter = 0
    root.manualExpand = false
    root.expanded = query.trim() !== ""
    if (root.expanded) root.runSearch()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
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

    var query = nextFilter.trim()
    if (/^go\s+/i.test(query)) {
      var searchTerms = query.slice(3).trim()
      if (searchTerms.length > 0) {
        displayModel.clear()
        displayModel.append({
          path: "https://www.google.com/search?q=" + encodeURIComponent(searchTerms),
          name: "Search Google for \"" + searchTerms + "\"",
          dir: "Google Search",
          icon: "󰍉",
          isDir: false,
          mtime: ""
        })
      }
    } else {
      if (displayModel.count > 0 && displayModel.get(0).dir === "Google Search") {
        displayModel.remove(0)
      }
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
    // Search only when expanded.
    if (!root.expanded) return
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
    var ranked = Backend.rankResults(items, root.filterText, Backend.DISPLAY_LIMIT)
    displayModel.clear()

    var query = root.filterText.trim()
    if (/^go\s+/i.test(query)) {
      var searchTerms = query.slice(3).trim()
      if (searchTerms.length > 0) {
        displayModel.append({
          path: "https://www.google.com/search?q=" + encodeURIComponent(searchTerms),
          name: "Search Google for \"" + searchTerms + "\"",
          dir: "Google Search",
          icon: "󰍉",
          isDir: false,
          mtime: ""
        })
      }
    }

    for (var i = 0; i < ranked.length; i++) {
      displayModel.append({
        path: ranked[i].path,
        name: ranked[i].name,
        dir: ranked[i].dir,
        icon: ranked[i].icon,
        isDir: ranked[i].isDir,
        mtime: ""
      })
    }
    if (root.selectedIndex >= displayModel.count) root.selectedIndex = displayModel.count - 1
    if (root.selectedIndex < 0) root.selectedIndex = 0
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    root.fetchMtimes()
  }

  // Batch stat for mtimes.
  function fetchMtimes() {
    if (displayModel.count === 0 || procStat.running) return
    var argv = ["stat", "-c", "%Y\t%n", "--"]
    var hasPaths = false
    for (var i = 0; i < displayModel.count; i++) {
      var path = displayModel.get(i).path
      if (path.indexOf("http://") !== 0 && path.indexOf("https://") !== 0) {
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
    if (root.filterText.trim() !== "") {
      // Keep relevance ranking, fill mtimes.
      for (var i = 0; i < displayModel.count; i++) {
        var path = displayModel.get(i).path
        if (path.indexOf("http://") === 0 || path.indexOf("https://") === 0) continue
        var ms = map[path]
        displayModel.setProperty(i, "mtime", ms === undefined ? "" : Backend.formatMtime(ms, now, root.locale))
      }
      return
    }
    // Empty query: sort by newest.
    var entries = []
    for (var j = 0; j < displayModel.count; j++) {
      var row = displayModel.get(j)
      var m = map[row.path]
      entries.push({
        path: row.path, name: row.name, dir: row.dir, icon: row.icon,
        isDir: row.isDir, ms: (m === undefined ? -1 : m)
      })
    }
    entries.sort(function(a, b) { return b.ms - a.ms })
      displayModel.clear()
      for (var k = 0; k < entries.length; k++) {
        displayModel.append({
          path: entries[k].path,
          name: entries[k].name,
          dir: entries[k].dir,
          icon: entries[k].icon,
          isDir: entries[k].isDir,
          mtime: entries[k].ms >= 0 ? Backend.formatMtime(entries[k].ms, now, root.locale) : ""
        })
      }
    root.selectedIndex = 0
    resultList.positionViewAtIndex(0, ListView.Contain)
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
        ? root.cardHeight
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
            if (root.filterText) root.setFilter("")
            else root.dismiss()
            event.accepted = true
          } else if (event.key === Qt.Key_Tab) {
            if (root.expanded) root.cycleFilter(1)
            else root.expandForBrowse()
            event.accepted = true
          } else if (event.key === Qt.Key_Backtab) {
            if (root.expanded) root.cycleFilter(-1)
            else root.expandForBrowse()
            event.accepted = true
          } else if (Util.editsFilter(event, root.filterText)) {
            root.setFilter(Util.editedFilter(event, root.filterText))
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            root.select(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_Down) {
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
            root.activateIndex(root.selectedIndex)
            event.accepted = true
          } else if (event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127) {
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
          visible: root.expanded
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

        Item {
          visible: root.expanded
          width: parent.width
          height: Math.max(0, parent.height - searchField.height - chips.height - footer.implicitHeight - root.contentSpacing * 3)

          ListView {
            id: resultList
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.bottomMargin: countLabel.visible ? countLabel.height + Style.space(4) : 0
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
            visible: displayModel.count === 0

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

          Text {
            id: countLabel
            visible: text !== ""
            anchors.bottom: parent.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.searching
              ? Backend.t("searching", root.locale)
              : (displayModel.count > 0
                 ? displayModel.count + Backend.t(displayModel.count === 1 ? "result" : "results", root.locale)
                 : "")
            color: root.accent
            opacity: 0.8
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }
        }

        Text {
          id: footer
          visible: root.expanded
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          text: Backend.t("footer", root.locale)
          color: root.foreground
          opacity: 0.45
          font.family: root.fontFamily
          font.pixelSize: Math.max(10, Style.font.body - 2)
        }
      }
    }
  }
}
