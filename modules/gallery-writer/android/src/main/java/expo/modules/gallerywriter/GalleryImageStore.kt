package expo.modules.gallerywriter

import android.content.ContentResolver
import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import android.system.ErrnoException
import android.system.OsConstants
import java.io.File
import java.io.IOException

class GalleryWriteFailure(val code: String, message: String, cause: Throwable? = null) : IOException(message, cause)

/** 取消与公开发布共享锁，不能在取消之后提交半成品。 */
class GalleryWriteRequest {
  private var cancelled = false
  @Synchronized fun cancel() { cancelled = true }
  @Synchronized fun checkActive() {
    if (cancelled) throw GalleryWriteFailure("GALLERY_INTERRUPTED", "图片保存已中断")
  }
  @Synchronized fun <T> publish(block: () -> T): T { checkActive(); return block() }
}

/** 只复制已经检查过的本地图片，不解码或转码；GIF/WebP 保留原始字节与动画。 */
class GalleryImageStore(private val resolver: ContentResolver) {
  fun save(file: File, mimeType: String, fileName: String, request: GalleryWriteRequest): Map<String, String> {
    var uri: android.net.Uri? = null
    try {
      request.checkActive()
      uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
        put(MediaStore.Images.Media.MIME_TYPE, mimeType)
        put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/RavenCat")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }) ?: throw GalleryWriteFailure("GALLERY_NOT_WRITABLE", "无法在系统相册创建图片")
      resolver.openOutputStream(uri, "w")?.use { output ->
        file.inputStream().use { input ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            request.checkActive()
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
          }
        }
      } ?: throw GalleryWriteFailure("GALLERY_NOT_WRITABLE", "系统相册目录不可写")
      val name = resolver.query(uri, arrayOf(MediaStore.Images.Media.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) throw GalleryWriteFailure("GALLERY_INTERRUPTED", "无法读取相册图片信息")
        cursor.getString(0)
      } ?: throw GalleryWriteFailure("GALLERY_INTERRUPTED", "无法读取相册图片信息")
      return request.publish {
        if (resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null) != 1) {
          throw GalleryWriteFailure("GALLERY_INTERRUPTED", "相册图片未能完成保存")
        }
        mapOf("uri" to uri.toString(), "fileName" to name)
      }
    } catch (error: Exception) {
      if (uri != null) try { resolver.delete(uri, null, null) } catch (cleanup: Exception) { error.addSuppressed(cleanup) }
      throw classifyGalleryFailure(error)
    }
  }
}

fun classifyGalleryFailure(error: Exception): GalleryWriteFailure {
  if (error is GalleryWriteFailure) return error
  val errno = generateSequence<Throwable>(error) { it.cause }.filterIsInstance<ErrnoException>().firstOrNull()?.errno
  return when {
    errno == OsConstants.ENOSPC || errno == OsConstants.EDQUOT -> GalleryWriteFailure("GALLERY_NO_SPACE", "存储空间不足，请释放空间后重试保存", error)
    error is SecurityException || errno == OsConstants.EACCES || errno == OsConstants.EROFS -> GalleryWriteFailure("GALLERY_NOT_WRITABLE", "系统相册目录不可写，请检查设备存储状态", error)
    else -> GalleryWriteFailure("GALLERY_INTERRUPTED", "图片保存中断，请重试保存", error)
  }
}
