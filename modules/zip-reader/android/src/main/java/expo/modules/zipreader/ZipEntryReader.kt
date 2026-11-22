package expo.modules.zipreader

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.util.zip.CRC32
import java.util.zip.CheckedInputStream
import java.util.zip.ZipException
import java.util.zip.ZipFile

internal object ZipEntryReader {
  fun readText(archive: File, name: String, limit: Int): String? {
    val output = ByteArrayOutputStream()
    return if (copyEntry(archive, name, limit) { output } == null) null else output.toString(Charsets.UTF_8.name())
  }

  fun extract(archive: File, name: String, target: File, limit: Int): Int? {
    try {
      return copyEntry(archive, name, limit, target::outputStream)
    } catch (_: ZipException) {
      // 损坏的单个附件按不可用处理，磁盘写入错误仍交给调用方。
      return null
    }
  }

  private fun copyEntry(archive: File, name: String, limit: Int, openOutput: () -> OutputStream): Int? {
    return ZipFile(archive).use { zip ->
      val entry = zip.getEntry(name) ?: return null
      if (entry.isDirectory || entry.size > limit) return null
      CheckedInputStream(zip.getInputStream(entry), CRC32()).use { input ->
        openOutput().use { output ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          var written = 0
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count > limit - written) return null
            output.write(buffer, 0, count)
            written += count
          }
          if (input.checksum.value != entry.crc) throw ZipException("Invalid ZIP entry CRC")
          written
        }
      }
    }
  }
}
