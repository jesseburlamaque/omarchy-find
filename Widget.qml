import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "jesseburlamaque.omarchy-find"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰍉"
    tooltipText: "Buscar arquivos"
    onPressed: function(b) {
      if (b === Qt.LeftButton && root.bar)
        root.bar.run("omarchy-shell shell toggle jesseburlamaque.omarchy-find '{}'")
    }
  }
}
