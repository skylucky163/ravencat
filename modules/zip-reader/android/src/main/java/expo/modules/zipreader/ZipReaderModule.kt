package expo.modules.zipreader

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ZipReaderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RavenCatZipReader")

    AsyncFunction("readText") { archiveUri: String, name: String, limit: Int ->
      ZipEntryReader.readText(cacheFile(archiveUri), name, limit)
    }

    AsyncFunction("extract") { archiveUri: String, name: String, targetUri: String, limit: Int ->
      ZipEntryReader.extract(cacheFile(archiveUri), name, cacheFile(targetUri), limit)
    }
  }

  private fun cacheFile(uri: String): File {
    val parsed = Uri.parse(uri)
    val path = requireNotNull(parsed.path)
    require(parsed.scheme == "file" && parsed.authority.isNullOrEmpty())
    val cache = requireNotNull(appContext.reactContext).cacheDir.canonicalFile
    val file = File(path).canonicalFile
    // ZIP 条目名只用于查找。写入地址由调用方指定，并限制在应用缓存内。
    require(file.path.startsWith(cache.path + File.separator))
    return file
  }
}
