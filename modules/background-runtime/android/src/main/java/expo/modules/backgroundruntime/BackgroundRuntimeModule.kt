package expo.modules.backgroundruntime

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import com.facebook.react.bridge.ReactContext
import android.os.Handler
import android.os.Looper

private class BackgroundRuntimeException(cause: Exception) : CodedException(cause.message, cause)

class BackgroundRuntimeModule : Module() {
  private var ownedContext: ReactContext? = null
  override fun definition() = ModuleDefinition {
    Name("BackgroundRuntime")
    Events("onExecutionRequests")
    AsyncFunction("connect") {
      val context = checkNotNull(appContext.reactContext) as ReactContext
      ownedContext = context
      ApplicationExecutionHost.connect(context) { sendEvent("onExecutionRequests", emptyMap<String, Any>()) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("post") { kind: String, data: Map<String, Any?>, timeoutMs: Long ->
      ApplicationExecutionHost.post(checkNotNull(appContext.reactContext), kind, data, timeoutMs)
    }
    AsyncFunction("takePending") { ApplicationExecutionHost.takePending() }
    AsyncFunction("complete") { id: String -> ApplicationExecutionHost.complete(id) }
    AsyncFunction("getState") { BackgroundRuntime.state(checkNotNull(appContext.reactContext)) }
    AsyncFunction("setEnabled") Coroutine { enabled: Boolean ->
      try { BackgroundRuntime.setEnabled(checkNotNull(appContext.reactContext), enabled) }
      catch (failure: Exception) { throw BackgroundRuntimeException(failure) }
    }
    AsyncFunction("reconcile") Coroutine { ->
      try { BackgroundRuntime.reconcile(checkNotNull(appContext.reactContext)) }
      catch (failure: Exception) { throw BackgroundRuntimeException(failure) }
    }
    OnDestroy {
      ownedContext?.let { context -> Handler(Looper.getMainLooper()).post { ApplicationExecutionHost.disconnect(context) } }
    }
  }
}
