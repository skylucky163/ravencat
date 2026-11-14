package expo.modules.modalwindow

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ModalWindowModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ModalWindow")
    View(ModalWindowView::class) {}
  }
}
