package expo.modules.kimiphonenotifications

import expo.modules.androidoverlayruntime.CallPresentationReturn
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.drawable.RoundedBitmapDrawableFactory

/**
 * 系统来电 surface：只负责把来电呈现给用户，并把 open/accept/reject 动作
 * 通过 NotificationResponseDispatcher 交回现有 JS 链路（最终由 AICallRuntimeService 决定业务状态）。
 *
 * 明确不拥有的职责：不读写 CallSession、不维护 ringing/active/missed 状态、不做业务超时、
 * 不调用 AI。业务结束时由 NotificationPublisher.dismissIncomingCall 经
 * IncomingCallSurfaceRegistry 关闭本 Activity。
 */
class IncomingCallActivity : Activity() {
  private var registeredCallId: String? = null
  private var returnToPreviousApp = false

  private companion object {
    const val TAG = "IncomingCallActivity"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 新 Activity 创建早于原页面 onStop；捕获来电壳盖上去之前的可见性。
    returnToPreviousApp = savedInstanceState?.getBoolean("returnToPreviousApp")
      ?: !CallPresentationReturn.isAppVisible
    // Manifest 同样声明了 showWhenLocked/turnScreenOn；API 27+ 显式调用保证生效。
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    // 非安全锁屏（滑动解锁）下直接解除 keyguard：部分 OEM（如 vivo）的自定义锁屏会盖在
    // showWhenLocked Activity 之上，表现为“屏被唤亮但看不到来电 UI”；
    // 安全锁（PIN/指纹）不受影响，仍由系统决定。来电/闹钟类应用的标准用法。
    getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
    handleIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // launchMode=singleTop：来电页已显示时再点系统通知的接听/拒绝，新 Intent 走这里而不是 onCreate。
    setIntent(intent)
    handleIntent(intent)
  }

  private fun handleIntent(intent: Intent) {
    val action = intent.getStringExtra("notificationAction") ?: "open"
    // 真机排障日志：锁屏“屏亮无界面”时用于区分 Activity 未启动 / payload 不全 / 被锁屏盖住。
    Log.i(TAG, "handleIntent action=$action callId=${intent.getStringExtra("callId")}")
    when (action) {
      "accept" -> handleAccept(intent)
      "reject" -> handleReject(intent)
      else -> renderIncomingSurface(intent)
    }
  }

  override fun onDestroy() {
    registeredCallId?.let { IncomingCallSurfaceRegistry.unregister(it, this) }
    super.onDestroy()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    outState.putBoolean("returnToPreviousApp", returnToPreviousApp)
    super.onSaveInstanceState(outState)
  }

  /** 接听：显式记录 accept response（渲染壳的 intent action 是 open，不能复用），拉起主 Activity 交给 Host 消费，自身退出。 */
  private fun handleAccept(intent: Intent) {
    val callId = intent.getStringExtra("callId")?.takeIf { it.isNotBlank() } ?: return
    NotificationResponseDispatcher.buildResponse(intent, "accept")?.let { response ->
      CallPresentationReturn.entered(callId, returnToPreviousApp)
      NotificationResponseDispatcher.recordForApp(applicationContext, response)
    }
    dismissSurface(intent)
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

  /** 拒接：显式记录 reject response（同上，不能复用 open intent 的 action），维持无 UI Headless 路径。 */
  private fun handleReject(intent: Intent) {
    NotificationResponseDispatcher.buildResponse(intent, "reject")?.let { response ->
      NotificationResponseDispatcher.recordCallAction(applicationContext, response)
    }
    dismissSurface(intent)
    finish()
  }

  private fun dismissSurface(intent: Intent) {
    intent.getStringExtra("callId")?.let { callId ->
      NotificationPublisher.dismissIncomingCall(applicationContext, callId)
    }
  }

  /** action=open（通知本体点击 / FullScreenIntent）：渲染轻量来电 UI。 */
  private fun renderIncomingSurface(intent: Intent) {
    val callId = intent.getStringExtra("callId")
    val aiName = intent.getStringExtra("aiName")?.trim().orEmpty()
    if (callId.isNullOrEmpty() || aiName.isEmpty()) {
      // payload 不完整时无法构成有效来电壳，直接退出，不伪造业务动作。
      Log.w(TAG, "renderIncomingSurface payload incomplete, finish. callId=$callId aiName=$aiName")
      finish()
      return
    }
    registeredCallId = callId
    IncomingCallSurfaceRegistry.register(callId, this)

    val density = resources.displayMetrics.density
    fun dp(value: Int): Int = (value * density).toInt()

    // 头像：有图用 RoundedBitmapDrawableFactory 圆形裁剪；无图/解码失败时显示
    // 圆形占位（半透明圆 + AI 名字首字符），对齐 RN CallActiveScreen 的观感。
    val avatarView: View
    val avatarBitmap = NotificationPublisher.loadBitmap(this, intent.getStringExtra("aiAvatar"))
    if (avatarBitmap != null) {
      avatarView = ImageView(this).apply {
        val size = dp(120)
        layoutParams = LinearLayout.LayoutParams(size, size)
        scaleType = ImageView.ScaleType.FIT_XY
        setImageDrawable(
          RoundedBitmapDrawableFactory.create(resources, avatarBitmap).apply { isCircular = true },
        )
      }
    } else {
      // 首字符取 aiName 的第一个 code point；非字母数字（符号、emoji 等）显示「？」。
      val firstCodePoint = aiName.codePointAt(0)
      val placeholderText = if (Character.isLetterOrDigit(firstCodePoint)) {
        String(Character.toChars(firstCodePoint))
      } else {
        "？"
      }
      avatarView = TextView(this).apply {
        val size = dp(120)
        layoutParams = LinearLayout.LayoutParams(size, size)
        text = placeholderText
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 44f)
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        background = GradientDrawable().apply {
          shape = GradientDrawable.OVAL
          setColor(Color.argb(0.22f, 1f, 1f, 1f))
          setStroke(dp(1), Color.argb(0.38f, 1f, 1f, 1f))
        }
      }
    }
    val nameView = TextView(this).apply {
      text = aiName
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_DIP, 28f)
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }
    val hintView = TextView(this).apply {
      text = "视频来电"
      setTextColor(Color.argb(255, 170, 178, 189))
      setTextSize(TypedValue.COMPLEX_UNIT_DIP, 16f)
      gravity = Gravity.CENTER
    }

    val header = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      addView(avatarView)
      addView(nameView, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply { topMargin = dp(24) })
      addView(hintView, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply { topMargin = dp(8) })
    }

    // 圆形色块按钮 + 下方白色标签：圆盘内居中白色电话图标（padding 控制图标约 28dp）。
    fun actionButton(label: String, color: Int, iconRes: Int, onClick: () -> Unit): View {
      return LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        val disc = ImageView(this@IncomingCallActivity).apply {
          val size = dp(64)
          layoutParams = LinearLayout.LayoutParams(size, size)
          background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
          }
          setImageResource(iconRes)
          val iconPadding = dp(18)
          setPadding(iconPadding, iconPadding, iconPadding, iconPadding)
        }
        val labelView = TextView(this@IncomingCallActivity).apply {
          text = label
          setTextColor(Color.WHITE)
          setTextSize(TypedValue.COMPLEX_UNIT_DIP, 14f)
          gravity = Gravity.CENTER
        }
        addView(disc)
        addView(labelView, LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT,
          LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(8) })
        setOnClickListener { onClick() }
      }
    }

    val actions = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      addView(actionButton("拒绝", Color.parseColor("#FF453A"), R.drawable.ic_call_reject) { handleReject(intent) })
      addView(View(this@IncomingCallActivity), LinearLayout.LayoutParams(dp(72), 1))
      addView(actionButton("接听", Color.parseColor("#30D158"), R.drawable.ic_call_answer) { handleAccept(intent) })
    }

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.rgb(16, 24, 32))
      addView(header, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        0,
        1f,
      ))
      addView(actions, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply { bottomMargin = dp(72) })
    }
    setContentView(root)
  }
}
