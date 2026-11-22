package expo.modules.kimiphonenotifications

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * 消息和一起听通知共用的直接 Activity PendingIntent 入口。
 * 先持久化 navigation response，再把用户带回 RavenCat；不经过 Android 12+ 禁止的广播 trampoline。
 */
class NotificationOpenActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    deliver(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    deliver(intent)
  }

  private fun deliver(source: Intent) {
    NotificationResponseDispatcher.buildResponse(source)?.let { response ->
      if (response["type"] == "ai-message" || response["type"] == "ai-message-summary") {
        NotificationPublisher.dismissConversation(applicationContext, response["conversationKey"] as? String)
      }
      NotificationResponseDispatcher.recordForApp(applicationContext, response)
    }
    packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
      launchIntent.addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP,
      )
      startActivity(launchIntent)
    }
    finish()
  }
}
