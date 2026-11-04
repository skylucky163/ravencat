package expo.modules.messagebubble

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

/** 文件身份不可变；尺寸变化与切线编辑不产生新的解码或缓存项。 */
internal object BubbleBitmapCache {
  private val executor = Executors.newFixedThreadPool(2)
  private val lock = Any()
  private val pending = mutableMapOf<String, CompletableFuture<Bitmap>>()
  private val cache = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
  }

  fun load(uri: String): CompletableFuture<Bitmap> = synchronized(lock) {
    cache.get(uri)?.let { return@synchronized CompletableFuture.completedFuture(it) }
    pending[uri]?.let { return@synchronized it }
    val future = CompletableFuture.supplyAsync({ decode(uri) }, executor)
    pending[uri] = future
    future.whenComplete { bitmap, error ->
      synchronized(lock) {
        if (error == null) cache.put(uri, bitmap)
        pending.remove(uri)
      }
    }
    future
  }

  private fun decode(uri: String): Bitmap {
    check(Thread.currentThread() != android.os.Looper.getMainLooper().thread)
    val parsed = Uri.parse(uri)
    require(parsed.scheme == "file") { "气泡素材必须是应用持久文件" }
    val file = File(java.net.URI(uri))
    require(file.isFile && file.length() in 1..8L * 1024 * 1024) { "PNG 不存在或超过 8 MiB" }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    require(bounds.outMimeType == "image/png" && bounds.outWidth in 3..2048 && bounds.outHeight in 3..2048) {
      "请选择边长 3–2048 像素的 PNG 图片"
    }
    val options = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inScaled = false
    }
    return requireNotNull(BitmapFactory.decodeFile(file.path, options)) { "PNG 解码失败" }
  }
}
