package expo.modules.gallerywriter

import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.ConcurrentHashMap

class GalleryWriterModule : Module() {
  private val requests = ConcurrentHashMap<String, GalleryWriteRequest>()
  override fun definition() = ModuleDefinition {
    Name("GalleryWriter")
    Function("begin") { id: String -> check(requests.putIfAbsent(id, GalleryWriteRequest()) == null) }
    Function("cancel") { id: String -> requests[id]?.cancel() }
    AsyncFunction("save") { id: String, sourceUri: String, mimeType: String, fileName: String, promise: Promise ->
      try {
        val context = checkNotNull(appContext.reactContext)
        val uri = Uri.parse(sourceUri)
        require(uri.scheme == "file") { "只能保存应用本地图片" }
        val file = File(checkNotNull(uri.path)).canonicalFile
        // 原生文件边界限制可读取范围，不能借相册写入导出任意系统文件。
        require(listOf(context.filesDir, context.cacheDir).any { file.toPath().startsWith(it.canonicalFile.toPath()) }) { "图片不在应用私有目录内" }
        require(mimeType in setOf("image/jpeg", "image/png", "image/gif", "image/webp")) { "不支持的图片类型" }
        require(fileName.isNotBlank() && !fileName.contains('/') && !fileName.contains('\\')) { "无效的相册文件名" }
        promise.resolve(GalleryImageStore(context.contentResolver).save(file, mimeType, fileName, checkNotNull(requests[id])))
      } catch (error: Exception) {
        val failure = classifyGalleryFailure(error)
        promise.reject(failure.code, failure.message, failure)
      } finally { requests.remove(id) }
    }
    OnActivityEntersBackground { requests.values.forEach { it.cancel() } }
    OnDestroy { requests.values.forEach { it.cancel() } }
  }
}
