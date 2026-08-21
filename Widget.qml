import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

BarWidget {
  id: root
  moduleName: "jesseburlamaque.omarchy-find"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property bool opened: root.bar && root.bar.shell && typeof root.bar.shell.isPluginOpen === "function"
    ? root.bar.shell.isPluginOpen(root.moduleName)
    : false

  function open() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.summon === "function") {
      root.bar.shell.summon(root.moduleName, "{}")
    } else if (root.bar && typeof root.bar.run === "function") {
      root.bar.run("omarchy-shell shell summon " + root.moduleName + " '{}'")
    } else {
      Quickshell.execDetached(["omarchy-find", "open", "{}"])
    }
  }

  function close() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.hide === "function") {
      root.bar.shell.hide(root.moduleName)
    } else if (root.bar && typeof root.bar.run === "function") {
      root.bar.run("omarchy-shell shell hide " + root.moduleName)
    } else {
      Quickshell.execDetached(["omarchy-find", "close"])
    }
  }

  function toggle() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.toggle === "function") {
      root.bar.shell.toggle(root.moduleName, "{}")
    } else if (root.bar && typeof root.bar.run === "function") {
      root.bar.run("omarchy-shell shell toggle " + root.moduleName + " '{}'")
    } else {
      Quickshell.execDetached(["omarchy-find", "toggle", "{}"])
    }
  }

  IpcHandler {
    target: root.moduleName

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
    active: root.opened
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.toggle()
    }
  }
}
