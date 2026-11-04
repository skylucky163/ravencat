package expo.modules.backgroundruntime

import android.app.Application
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.interfaces.TaskInterface
import java.lang.reflect.Proxy
import java.util.concurrent.TimeUnit

/** 用可完成的框架启动边界代替真实 JS 引擎；业务派发和资源管理仍执行产品代码。 */
class ExecutionTestApplication : Application(), ReactApplication {
  private val started = object : TaskInterface<Void> {
    override fun waitForCompletion() = Unit
    override fun waitForCompletion(duration: Long, unit: TimeUnit) = true
    override fun getResult(): Void? = null
    override fun getError(): Exception? = null
    override fun isCompleted() = true
    override fun isCancelled() = false
    override fun isFaulted() = false
  }
  override val reactNativeHost = object : ReactNativeHost(this) {
    override fun getUseDeveloperSupport() = false
    override fun getPackages(): List<ReactPackage> = emptyList()
  }
  override val reactHost: ReactHost = Proxy.newProxyInstance(ReactHost::class.java.classLoader,
    arrayOf(ReactHost::class.java)) { _, method, _ ->
    if (method.name == "start") started else null
  } as ReactHost
}
