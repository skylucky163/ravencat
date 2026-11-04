package expo.modules.callruntime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import expo.modules.backgroundruntime.ApplicationExecutionHost
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import androidx.core.telecom.*
import expo.modules.androidoverlayruntime.OverlayLaunchIntentFactory
import expo.modules.androidoverlayruntime.OverlayInteractionExclusion
import expo.modules.callringtone.CallRingtonePlayback
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first

/** 一次通话的有界执行期，任务完成即释放；不随产品开关常驻，不自重启。 */
class CallExecutionService : Service() {
  internal lateinit var callId: String
  internal lateinit var returnUri: Uri
  internal var name = ""
  internal var avatarBitmap: Bitmap? = null
    private set
  private var direction = ""
  internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  internal val camera by lazy { CallCameraSession(this) }
  internal val overlay by lazy { CallOverlayController(this) }
  private val telecom by lazy {
    CallTelecomSession(scope,
      addCall = { block ->
        val manager = CallsManager(this)
        manager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_SUPPORTS_VIDEO_CALLING)
        // 来电邀请只由应用响铃；用户接听后才注册系统通话，与去电共用激活和释放。
        manager.addCall(
          CallAttributesCompat(name, Uri.parse("ravencat-call:$callId"),
            if (direction == "incoming") CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
            CallAttributesCompat.CALL_TYPE_VIDEO_CALL, callCapabilities = 0),
          onAnswer = { },
          onDisconnect = { endFromTelecom("hangup") },
          onSetActive = { check(CallExecutionRegistry.alive && !finishing) },
          onSetInactive = { endFromTelecom("interrupted") },
          block = block,
        )
      },
      onEnded = { endFromTelecom() },
    )
  }
  private var route: CallAudioRouteController? = null
  private var endpoints = emptyList<CallEndpointCompat>()
  private var endpoint: CallEndpointCompat? = null
  private val endpointIds = linkedMapOf<String, Int>()
  private var microphoneTypeAcquired = false
  private var cameraEnabled = false
  internal var finishing = false
    private set
  private var started = false
  private var connectedAt: Long? = null
  private var finishTask: Deferred<Unit>? = null
  private var terminalTask: Job? = null
  private var terminalCommand: Deferred<Unit>? = null
  private var mediaAttached = false
  private var cameraRevision = 0
  private val handler = Handler(Looper.getMainLooper())

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "hangup") {
      if (intent.getStringExtra("callId") == CallExecutionRegistry.callId) {
        scope.launch {
          try { CallExecutionRegistry.command("hangup") }
          catch (failure: Exception) { finish() }
        }
      }
      return Service.START_NOT_STICKY
    }
    if (started) return Service.START_NOT_STICKY
    if (!CallExecutionRegistry.alive || intent?.getStringExtra("callId") != CallExecutionRegistry.callId) {
      stopSelf(startId)
      return Service.START_NOT_STICKY
    }
    started = true
    val startIntent = checkNotNull(intent)
    callId = startIntent.getStringExtra("callId")!!
    name = startIntent.getStringExtra("name")!!
    direction = startIntent.getStringExtra("direction")!!
    returnUri = Uri.parse(startIntent.getStringExtra("returnUri")!!)
    CallExecutionRegistry.host = this
    try {
      OverlayInteractionExclusion.acquire(this)
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
        NotificationChannel(CHANNEL, "正在通话", NotificationManager.IMPORTANCE_LOW),
      )
      updateForeground()
      if (startIntent.getBooleanExtra("ringing", false)) {
        CallRingtonePlayback.start(this, callId, startIntent.getStringExtra("ringtoneUri"), "outgoing")
      }
      startIntent.getStringExtra("avatarUri")?.let { uri ->
        scope.launch {
          val bitmap = loadAvatar(uri)
          if (finishing) return@launch
          avatarBitmap = bitmap
          overlay.avatarChanged()
          updateForeground()
        }
      }
      overlay.setAppVisible(CallExecutionRegistry.appVisible)
      // 媒体延续同一个应用执行宿主；总开关关闭也不能提前结束正在进行的通话。
      ApplicationExecutionHost.attachMedia(this, callId)
      mediaAttached = true
      check(ApplicationExecutionHost.post(this, "call", mapOf("callId" to callId), 0L))
    } catch (failure: Exception) {
      CallExecutionRegistry.ready.completeExceptionally(failure)
      finish()
    }
    return Service.START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null
  internal suspend fun activate() {
    CallRingtonePlayback.stop(callId)
    var stage = "注册系统通话"
    try {
      telecom.activate { control ->
        with(control) {
          stage = "激活系统通话"
          val result = if (direction == "incoming") answer(CallAttributesCompat.CALL_TYPE_VIDEO_CALL) else setActive()
          check(result is CallControlResult.Success) { "系统无法接通电话：$result" }
          stage = "等待可用音频端点"
          endpoints = availableEndpoints.first { it.isNotEmpty() }
          stage = "等待当前音频端点"
          endpoint = currentCallEndpoint.first()
          stage = "确认初始音频路由"
          val controller = CallAudioRouteController(callId,
            getDevices = { endpoints.mapNotNull { device(it) } },
            getCurrentDevice = { endpoint?.let { device(it) } },
            requestDevice = { id ->
              val target = endpoints.first { device(it)?.id == id }
              telecom.audioScope.launch {
                try {
                  val changed = requestEndpointChange(target)
                  if (changed is CallControlResult.Error) route?.requestFailed(id, "系统未接受音频设备切换：$changed")
                } catch (failure: Exception) { route?.requestFailed(id, failure.message ?: "系统未接受音频设备切换") }
              }
              true
            },
            scheduleTimeout = { timeout ->
              val task = Runnable { timeout() }
              handler.postDelayed(task, 30_000)
              val cancel: () -> Unit = { handler.removeCallbacks(task) }
              cancel
            },
            emit = { CallExecutionRegistry.emit?.invoke("onRoute", it) },
          )
          route = controller
          telecom.audioScope.launch { currentCallEndpoint.collect { endpoint = it; controller.actualChanged() } }
          telecom.audioScope.launch { availableEndpoints.collect { endpoints = it; controller.devicesChanged() } }
          telecom.audioScope.launch { isMuted.collect { muted -> CallExecutionRegistry.command("mute", muted) } }
          val routed = CompletableDeferred<Unit>()
          controller.begin { message ->
            if (message == null) routed.complete(Unit)
            else routed.completeExceptionally(IllegalStateException(message))
          }
          routed.await()
          connectedAt = System.currentTimeMillis()
          updateForeground()
        }
      }
      overlay.connected()
    } catch (failure: Exception) {
      throw IllegalStateException(
        "原生通话建立失败（$stage）：${failure.message ?: failure.toString()}\n" +
          "设备：${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}，Android ${android.os.Build.VERSION.RELEASE} / API ${android.os.Build.VERSION.SDK_INT}\n" +
          "当前端点类型：${endpoint?.type ?: "未收到"}，可用端点类型：${endpoints.map { it.type }}",
        failure,
      )
    }
  }

  private fun device(value: CallEndpointCompat): CallAudioDevice? {
    val kind = when (value.type) {
      CallEndpointCompat.TYPE_EARPIECE -> "earpiece"
      CallEndpointCompat.TYPE_SPEAKER -> "speaker"
      CallEndpointCompat.TYPE_BLUETOOTH, CallEndpointCompat.TYPE_WIRED_HEADSET -> "headset"
      else -> return null
    }
    val id = endpointIds.getOrPut(value.identifier.toString()) { endpointIds.size + 1 }
    return CallAudioDevice(id, kind)
  }

  internal fun routeState(): Map<String, Any?>? = route?.snapshot()

  internal suspend fun releaseAudio() {
    finishing = true
    val released = telecom.close()
    try {
      CallRingtonePlayback.stop(callId)
      route?.close()
      route = null
    } finally { released.await() }
  }

  private fun endFromTelecom(action: String? = null) {
    if (action != null && terminalCommand == null) {
      terminalCommand = scope.async(start = CoroutineStart.LAZY) { CallExecutionRegistry.command(action) }
    }
    if (terminalTask != null) return
    finishing = true
    val task = scope.launch(start = CoroutineStart.LAZY) {
      try {
        terminalCommand?.start()
        // 系统回调立即返回，不能让它等待 JS 再反向等待本次系统断开，形成环路。
        releaseAudio()
        val command = terminalCommand
        if (command != null) command.await()
        else if (CallExecutionRegistry.alive) CallExecutionRegistry.command("interrupted")
      } catch (failure: Exception) {
        android.util.Log.e("CallExecution", "系统通话结束收口失败", failure)
      } finally { finish() }
    }
    terminalTask = task
    task.start()
  }

  internal suspend fun selectRoute(value: String) {
    val result = CompletableDeferred<Unit>()
    checkNotNull(route).select(value) { message ->
      if (message == null) result.complete(Unit) else result.completeExceptionally(IllegalStateException(message))
    }
    result.await()
  }

  internal fun setMicrophone(enabled: Boolean) {
    // 在可见流程首次取得 microphone 执行资格，保留到通话结束。
    // 静音/文字输入仍停止真实采集；不能撤销服务资格后再从后台重新申请。
    if (enabled && !microphoneTypeAcquired) {
      microphoneTypeAcquired = true
      try { updateForeground() }
      catch (failure: Exception) { microphoneTypeAcquired = false; throw failure }
    }
  }

  internal suspend fun setCamera(enabled: Boolean, facing: String) {
    val revision = ++cameraRevision
    cameraEnabled = enabled
    try {
      // 先切换展示并挂载预览，不能等相机绑定完成后才给它 surface。
      overlay.setCameraEnabled(enabled)
      updateForeground(); camera.setEnabled(enabled, facing)
    }
    catch (failure: Exception) {
      if (revision == cameraRevision) { cameraEnabled = false; overlay.setCameraEnabled(false); updateForeground() }
      throw failure
    }
  }

  private fun updateForeground() {
    var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
    if (microphoneTypeAcquired) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    if (cameraEnabled) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    startForeground(NOTIFICATION_ID, notification(), types)
  }

  private fun notification(): Notification {
    val hangupIntent = Intent(this, CallExecutionService::class.java).apply { action = "hangup"; putExtra("callId", callId) }
    val hangup = PendingIntent.getService(this, callId.hashCode(), hangupIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val caller = Person.Builder().setName(name).apply {
      avatarBitmap?.let { setIcon(IconCompat.createWithBitmap(it)) }
    }.build()
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setLargeIcon(avatarBitmap)
      .setContentTitle(name).setContentText(if (connectedAt == null) "正在接通" else "视频通话中")
      .setContentIntent(OverlayLaunchIntentFactory.createPendingIntent(this, returnUri))
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangup))
      .setOngoing(true).setCategory(NotificationCompat.CATEGORY_CALL)
      .setWhen(connectedAt ?: System.currentTimeMillis()).setUsesChronometer(connectedAt != null).build()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    camera.updateRotation()
    if (started) overlay.reposition()
  }

  private suspend fun loadAvatar(value: String): Bitmap? = withContext(Dispatchers.IO) {
    // 文件边界只在宿主读取一次，小窗与系统通知共享头像；图片失败不终止媒体。
    try {
      val uri = Uri.parse(value)
      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) }
      check(options.outWidth > 0 && options.outHeight > 0) { "通话头像不是有效图片" }
      var sample = 1
      while (maxOf(options.outWidth, options.outHeight) / (sample * 2) >= 512) sample *= 2
      contentResolver.openInputStream(uri).use {
        checkNotNull(BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }))
      }
    } catch (failure: Exception) {
      if (failure is CancellationException) throw failure
      android.util.Log.w("CallExecution", "通话头像读取失败", failure)
      null
    }
  }

  internal fun finish(): Deferred<Unit> {
    finishTask?.let { return it }
    finishing = true
    CallExecutionRegistry.alive = false
    val task = scope.async(start = CoroutineStart.LAZY) {
      try { releaseAudio() }
      finally {
        try { overlay.close(); camera.close() }
        finally {
          OverlayInteractionExclusion.release(this@CallExecutionService)
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf()
        }
      }
    }
    finishTask = task
    task.start()
    return task
  }

  override fun onDestroy() {
    // 系统销毁同样走有界断开；在它完成前不能取消拿着 Telecom 句柄的 scope。
    if (started) {
      val closing = finish()
      scope.launch {
        var failure: Throwable? = null
        try { closing.await() }
        catch (cause: Exception) {
          failure = cause
          android.util.Log.e("CallExecution", "系统通话释放失败", cause)
        } finally {
          CallExecutionRegistry.cancelled(this@CallExecutionService, failure)
          scope.cancel()
        }
      }
    } else scope.cancel()
    if (mediaAttached) ApplicationExecutionHost.detachMedia(callId)
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "ravencat-ongoing-call"
    private const val NOTIFICATION_ID = 41073
  }
}
