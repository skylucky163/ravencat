package expo.modules.backupstorage

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class BackupArchiveTest {
  @get:Rule val temporary = TemporaryFolder()

  private val database = "SQLite fixture".toByteArray()
  private val settings = """{"baseUrl":"https://example.test","apiKey":"fixture-key","appId":"fixture-app","secretId":"fixture-secret"}""".toByteArray()
  private val media = ByteArray(256 * 1024) { (it * 31).toByte() }
  private val paths = listOf("database/raven.db", "settings/stable-settings.json", "media/persistent-media/图片.jpg")
  private val contents get() = listOf(database, settings, media)

  private fun artifact(
    version: Int = 2,
    contract: Int = 1,
    declaredPaths: List<String> = paths,
    declaredSizes: List<Long> = contents.map { it.size.toLong() },
    sources: List<BackupArchiveSource> = paths.zip(contents).map { (path, bytes) ->
      BackupArchiveSource(path, null, bytes, bytes.size.toLong())
    },
  ): ByteArray {
    val entries = JSONArray()
    declaredPaths.zip(declaredSizes).forEach { (path, size) ->
      entries.put(JSONObject().put("path", path).put("byteLength", size))
    }
    val manifest = JSONObject()
      .put("backupFormatVersion", version).put("databaseContractVersion", contract)
      .put("sourcePlatform", "android").put("sourceAndroidApi", 33)
      .put("createdAt", "2026-10-06T00:00:00Z").put("appVersion", "2.0.0")
      .put("entries", entries).toString().toByteArray()
    val header = JSONObject().put("formatVersion", version).put("cipher", "none")
      .toString().toByteArray()
    val output = temporary.newFile()
    BackupArchive.write(output, header, manifest, sources)
    return output.readBytes()
  }

  private fun extract(bytes: ByteArray): File {
    val staging = temporary.newFolder()
    BackupArchive.extract(bytes.inputStream(), staging, 1)
    return staging
  }

  @Test fun roundTripWithoutPasswordPreservesConfigurationAndMedia() {
    val mediaFile = temporary.newFile().apply { writeBytes(media) }
    val sources = paths.zip(contents).mapIndexed { index, (path, bytes) ->
      if (index == 2) BackupArchiveSource(path, mediaFile, null, mediaFile.length())
      else BackupArchiveSource(path, null, bytes, bytes.size.toLong())
    }
    val staging = extract(artifact(sources = sources))
    paths.zip(contents).forEach { (path, bytes) ->
      assertArrayEquals(bytes, File(staging, path).readBytes())
    }
  }

  @Test fun rejectsUnsupportedFormatAndDatabaseContracts() {
    assertThrows(IllegalArgumentException::class.java) { extract(artifact(version = 1)) }
    assertThrows(IllegalArgumentException::class.java) { extract(artifact(contract = 0)) }
    assertThrows(IllegalArgumentException::class.java) { extract(artifact(contract = 2)) }
  }

  @Test fun roundTripPreservesLargeDiagnosticsInStableSettings() {
    val fullBody = "完整诊断📦".repeat(100_000)
    val largeSettings = JSONObject().put("aiHttpDiagnostics", JSONObject()
      .put("version", 1).put("enabled", false).put("records", JSONArray().put(JSONObject()
        .put("requestBody", fullBody).put("responseBody", "data: [DONE]\n"))))
      .toString().toByteArray(Charsets.UTF_8)
    assertTrue(largeSettings.size > 1024 * 1024)
    val payloads = listOf(database, largeSettings, media)
    val staging = extract(artifact(
      declaredSizes = payloads.map { it.size.toLong() },
      sources = paths.zip(payloads).map { (path, bytes) ->
        BackupArchiveSource(path, null, bytes, bytes.size.toLong())
      },
    ))
    assertArrayEquals(largeSettings, File(staging, "settings/stable-settings.json").readBytes())
  }

  @Test fun rejectsMissingExtraDuplicateAndEscapingPaths() {
    assertThrows(IllegalArgumentException::class.java) { extract(artifact(sources = emptyList())) }
    assertThrows(IllegalArgumentException::class.java) {
      extract(artifact(declaredPaths = paths.take(2), declaredSizes = contents.take(2).map { it.size.toLong() }))
    }
    assertThrows(IllegalArgumentException::class.java) {
      extract(artifact(declaredPaths = paths + paths[0], declaredSizes = contents.map { it.size.toLong() } + database.size.toLong()))
    }
    assertThrows(IllegalArgumentException::class.java) {
      extract(artifact(declaredPaths = paths.take(2) + "../outside.jpg"))
    }
    assertFalse(File(temporary.root.parentFile, "outside.jpg").exists())
  }

  @Test fun rejectsLengthMismatchAndCorruptedOrTruncatedPayload() {
    assertThrows(IllegalArgumentException::class.java) {
      extract(artifact(declaredSizes = listOf(database.size.toLong(), settings.size.toLong(), 1L)))
    }
    val bytes = artifact()
    // DEFLATED entry 的数据描述符包含 CRC；篡改它必须由真实 ZIP reader 拒绝。
    val descriptor = bytes.indices.first { index ->
      index + 4 < bytes.size && bytes[index] == 0x50.toByte() && bytes[index + 1] == 0x4b.toByte() &&
        bytes[index + 2] == 7.toByte() && bytes[index + 3] == 8.toByte()
    }
    val corrupt = bytes.copyOf().also { it[descriptor + 4] = (it[descriptor + 4].toInt() xor 1).toByte() }
    assertThrows(java.util.zip.ZipException::class.java) { extract(corrupt) }
    assertThrows(java.io.IOException::class.java) { extract(bytes.copyOf(descriptor - 2)) }
  }
}
