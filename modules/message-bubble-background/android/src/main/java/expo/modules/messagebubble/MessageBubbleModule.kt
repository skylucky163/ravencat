package expo.modules.messagebubble

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class BubbleSource : Record {
  @Field var uri: String = ""
  @Field var left: Int = 0
  @Field var top: Int = 0
  @Field var right: Int = 0
  @Field var bottom: Int = 0
  @Field var scale: Float = 1f
}

class MessageBubbleModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MessageBubbleBackground")
    // 等待共享解码时挂起，不阻塞 UI、JS 或其他模块的异步调用队列。
    AsyncFunction("prepare") Coroutine { uri: String ->
      suspendCancellableCoroutine<Map<String, Int>> { continuation ->
        BubbleBitmapCache.load(uri).whenComplete { bitmap, error ->
          if (error == null) continuation.resume(mapOf("width" to bitmap.width, "height" to bitmap.height))
          else continuation.resumeWithException(error.cause ?: error)
        }
      }
    }
    View(MessageBubbleView::class) {
      Events("onLoadError")
      Prop("source") { view: MessageBubbleView, source: BubbleSource -> view.setSource(source) }
      OnViewDestroys { view: MessageBubbleView -> view.dispose() }
    }
  }
}
