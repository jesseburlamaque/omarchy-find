import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

BarWidget {
  id: root
  moduleName: "jesseburlamaque.omarchy-find"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property bool opened: overlayOpened
  property bool overlayOpened: false
  property bool popoutSwitchClosing: false

  function open() {
    overlayOpened = true
    if (root.bar && root.bar.shell && typeof root.bar.shell.summon === "function") {
      root.bar.shell.summon(root.moduleName, "{}")
    } else if (root.bar && typeof root.bar.run === "function") {
      root.bar.run("omarchy-shell shell summon " + root.moduleName + " '{}'")
    } else {
      Quickshell.execDetached(["omarchy-find", "open", "{}"])
    }
  }

  function close() {
    overlayOpened = false
    if (root.bar && root.bar.shell && typeof root.bar.shell.hide === "function") {
      root.bar.shell.hide(root.moduleName)
    } else if (root.bar && typeof root.bar.run === "function") {
      root.bar.run("omarchy-shell shell hide " + root.moduleName)
    } else {
      Quickshell.execDetached(["omarchy-find", "close"])
    }
  }

  function toggle() {
    if (overlayOpened) root.close()
    else root.open()
  }

  function closeForPopoutSwitch() {
    popoutSwitchClosing = true
    close()
    Qt.callLater(function() { popoutSwitchClosing = false })
  }

  IpcHandler {
    target: root.moduleName

    function openedChanged(state): void {
      root.overlayOpened = state === true || state === "true"
    }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰍉"
    tooltipText: "Search files"
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.toggle()
    }
  }
}
