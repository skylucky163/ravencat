package expo.modules.nativetextselection

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NativeTextSelectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NativeTextSelection")
    AsyncFunction("releaseFocus") {
      releaseTextSelectionFocus(appContext.currentActivity?.currentFocus)
    }.runOnQueue(Queues.MAIN)
    View(OverflowPasteView::class) {
      Events("onOverflowPaste")
      Prop("inlineLimit") { view: OverflowPasteView, value: Int -> view.inlineLimit = value }
      Prop("attachmentLimit") { view: OverflowPasteView, value: Int -> view.attachmentLimit = value }
    }
  }
}
