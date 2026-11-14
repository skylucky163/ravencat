package expo.modules.backupstorage

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

internal data class BackupArchiveSource(
  val archivePath: String,
  val file: File?,
  val bytes: ByteArray?,
  val byteLength: Long,
)

/** 格式边界负责流式打包与外部文件校验，恢复引擎负责 SQLite 和激活生命周期。 */
internal object BackupArchive {
  private val magic = byteArrayOf(0x52, 0x41, 0x56, 0x45, 0x4E, 0x42, 0x4B, 0x50)
  private const val maxHeaderBytes = 64 * 1024
  private const val maxManifestBytes = 10 * 1024 * 1024
  private const val maxArchiveEntries = 100_000

  fun write(
    output: File,
    header: ByteArray,
    manifest: ByteArray,
    sources: List<BackupArchiveSource>,
  ) {
    FileOutputStream(output).use { fileOutput ->
      val dataOutput = DataOutputStream(BufferedOutputStream(fileOutput))
      dataOutput.write(magic)
      dataOutput.writeInt(header.size)
      dataOutput.write(header)
      dataOutput.flush()

      // 图片、音频多为已压缩格式；低压缩等级避免重复压缩占用大量时间。
      ZipOutputStream(dataOutput).use { zip ->
        zip.setLevel(java.util.zip.Deflater.BEST_SPEED)
        writeZipBytes(zip, "manifest.json", manifest)
        sources.forEach { source ->
          val entry = ZipEntry(source.archivePath).apply { time = 0L }
          zip.putNextEntry(entry)
          if (source.file != null) {
            BufferedInputStream(FileInputStream(source.file)).use { it.copyTo(zip) }
          } else {
            zip.write(source.bytes!!)
          }
          zip.closeEntry()
        }
      }
    }
  }

  private fun writeZipBytes(zip: ZipOutputStream, path: String, bytes: ByteArray) {
    zip.putNextEntry(ZipEntry(path).apply { time = 0L })
    zip.write(bytes)
    zip.closeEntry()
  }

  fun extract(
    rawInput: InputStream,
    staging: File,
    currentDatabaseContractVersion: Int,
  ): JSONObject {
    val input = DataInputStream(BufferedInputStream(rawInput))
    val actualMagic = ByteArray(magic.size).also(input::readFully)
    if (!actualMagic.contentEquals(magic)) throw IllegalArgumentException("不是 RavenCat 备份包")
    val headerLength = input.readInt()
    if (headerLength !in 1..maxHeaderBytes) throw IllegalArgumentException("备份包头无效")
    val headerBytes = ByteArray(headerLength).also(input::readFully)
    val header = JSONObject(String(headerBytes, Charsets.UTF_8))
    validateHeader(header)

    return extractZip(input, staging, currentDatabaseContractVersion)
  }

  private fun extractZip(input: InputStream, staging: File, currentDatabaseContractVersion: Int): JSONObject {
    ZipInputStream(input).use { zip ->
      val manifestEntry = zip.nextEntry
        ?: throw IllegalArgumentException("备份包没有清单")
      if (manifestEntry.name != "manifest.json") {
        throw IllegalArgumentException("备份包清单位置无效")
      }
      val manifest = JSONObject(String(readEntryBytes(zip, maxManifestBytes), Charsets.UTF_8))
      validateManifest(manifest, currentDatabaseContractVersion)
      val expected = expectedEntries(manifest, staging)
      val seen = mutableSetOf<String>()
      var entryCount = 1

      while (true) {
        val entry = zip.nextEntry ?: break
        entryCount += 1
        if (entryCount > maxArchiveEntries) throw IllegalArgumentException("备份文件数量过多")
        if (entry.isDirectory) continue
        val metadata = expected[entry.name]
          ?: throw IllegalArgumentException("备份包包含清单之外的文件")
        if (!seen.add(entry.name)) throw IllegalArgumentException("备份包包含重复文件")
        extractEntry(zip, staging, entry.name, metadata)
      }
      if (seen != expected.keys) throw IllegalArgumentException("备份包内容不完整")
      return manifest
    }
  }

  private fun validateHeader(header: JSONObject) {
    if (header.getInt("formatVersion") != 2 || header.getString("cipher") != "none") {
      throw IllegalArgumentException("不支持的备份格式，请使用新版创建的未加密备份")
    }
  }

  private fun validateManifest(manifest: JSONObject, currentContract: Int) {
    if (manifest.getInt("backupFormatVersion") != 2) {
      throw IllegalArgumentException("不支持的备份格式")
    }
    if (manifest.getString("sourcePlatform") != "android") {
      throw IllegalArgumentException("备份来源平台无效")
    }
    manifest.getInt("sourceAndroidApi")
    val contract = manifest.getInt("databaseContractVersion")
    if (contract > currentContract) throw IllegalArgumentException("该备份来自更高版本的 RavenCat")
    if (contract < currentContract) throw IllegalArgumentException("该备份不支持旧数据库契约")
  }

  private fun expectedEntries(
    manifest: JSONObject,
    staging: File,
  ): Map<String, Long> {
    val entries = manifest.getJSONArray("entries")
    if (entries.length() > maxArchiveEntries - 1) {
      throw IllegalArgumentException("备份文件数量过多")
    }
    val result = LinkedHashMap<String, Long>()
    var totalLength = 0L
    for (index in 0 until entries.length()) {
      val entry = entries.getJSONObject(index)
      val path = entry.getString("path")
      val byteLength = entry.getLong("byteLength")
      validateArchivePath(path)
      if (byteLength < 0) {
        throw IllegalArgumentException("备份清单元数据无效")
      }
      totalLength = Math.addExact(totalLength, byteLength)
      if (result.put(path, byteLength) != null) {
        throw IllegalArgumentException("备份清单包含重复路径")
      }
    }
    // 稳定设置包含完整 HTTP 诊断正文，大小随正文增长；统一按清单长度和可用空间约束。
    val availableBytes = staging.usableSpace
    if (totalLength > availableBytes - 64L * 1024L * 1024L) {
      throw IllegalArgumentException("存储空间不足，无法展开备份")
    }
    if (!result.containsKey("database/raven.db") ||
      !result.containsKey("settings/stable-settings.json")) {
      throw IllegalArgumentException("备份包缺少必要内容")
    }
    return result
  }

  private fun extractEntry(
    zip: ZipInputStream,
    staging: File,
    path: String,
    expectedLength: Long,
  ) {
    val target = File(staging, path).canonicalFile
    if (!target.toPath().startsWith(staging.canonicalFile.toPath())) {
      throw IllegalArgumentException("备份路径越界")
    }
    target.parentFile?.mkdirs()
    var total = 0L
    BufferedOutputStream(FileOutputStream(target)).use { output ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val count = zip.read(buffer)
        if (count < 0) break
        total += count
        if (total > expectedLength) throw IllegalArgumentException("备份文件长度与清单不符")
        output.write(buffer, 0, count)
      }
    }
    if (total != expectedLength) {
      throw IllegalArgumentException("备份文件校验失败")
    }
  }

  private fun validateArchivePath(path: String) {
    if (path.startsWith('/') || path.contains('\\') ||
      path.split('/').any { it.isEmpty() || it == "." || it == ".." }) {
      throw IllegalArgumentException("备份清单路径无效")
    }
  }

  private fun readEntryBytes(zip: ZipInputStream, limit: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    while (true) {
      val count = zip.read(buffer)
      if (count < 0) break
      if (output.size() + count > limit) throw IllegalArgumentException("备份清单过大")
      output.write(buffer, 0, count)
    }
    return output.toByteArray()
  }

}
