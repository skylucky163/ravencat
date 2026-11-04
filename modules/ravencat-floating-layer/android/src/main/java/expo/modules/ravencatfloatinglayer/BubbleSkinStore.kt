package expo.modules.ravencatfloatinglayer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import com.caverock.androidsvg.SVG
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.UUID

internal enum class BubbleSkinSource {
  BUILTIN,
  USER,
}

internal data class BubbleSkin(
  val id: String,
  val name: String,
  val source: BubbleSkinSource,
  val mimeType: String,
  val filePath: String? = null,
  val normalRawResource: Int? = null,
  val dockedFilePath: String? = null,
  val dockedMimeType: String? = null,
  val sizeDp: Int = BubbleSkinStore.DEFAULT_SIZE_DP,
) {
  val hasDockedAsset: Boolean get() = dockedFilePath != null

  fun toMap(selectedId: String): Map<String, Any?> = mapOf(
    "id" to id,
    "name" to name,
    "source" to source.name.lowercase(),
    "mimeType" to mimeType,
    "uri" to filePath?.let { Uri.fromFile(File(it)).toString() },
    "dockedUri" to dockedFilePath?.let { Uri.fromFile(File(it)).toString() },
    "dockedMimeType" to dockedMimeType,
    "hasDockedAsset" to hasDockedAsset,
    "selected" to (id == selectedId),
    "sizeDp" to sizeDp,
  )
}

/** 保存用户装扮并为脱离 React 生命周期的原生悬浮窗解析图片。 */
internal class BubbleSkinStore(private val context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  init {
    // 旧内置形象已经移除；只迁移已知旧 ID，不掩盖损坏的用户选择。
    val selected = preferences.getString(KEY_SELECTED_ID, DEFAULT_SKIN_ID)
    if (selected in RETIRED_BUILTIN_IDS) {
      check(preferences.edit().putString(KEY_SELECTED_ID, DEFAULT_SKIN_ID).commit()) {
        "无法迁移 RavenCat 默认装扮"
      }
    }
    if (preferences.contains(KEY_LEGACY_SIZE_DP)) {
      val size = preferences.getInt(KEY_LEGACY_SIZE_DP, DEFAULT_SIZE_DP)
      require(size in MIN_SIZE_DP..MAX_SIZE_DP) { "悬浮球大小无效" }
      // 原来的全局大小迁移成已有皮肤的初始值；此后每套皮肤独立修改。
      val sizes = JSONObject()
      (BUILTIN_SKINS + readCustomSkins()).forEach { sizes.put(it.id, size) }
      check(preferences.edit().putString(KEY_SKIN_SIZES, sizes.toString()).remove(KEY_LEGACY_SIZE_DP).commit()) {
        "无法迁移 RavenCat 皮肤大小"
      }
    }
  }

  fun list(): List<BubbleSkin> {
    val sizes = readSizeSettings()
    return (BUILTIN_SKINS + readCustomSkins()).map { withSize(it, sizes) }
  }

  fun selectedId(): String {
    val persisted = preferences.getString(KEY_SELECTED_ID, DEFAULT_SKIN_ID) ?: DEFAULT_SKIN_ID
    return persisted.takeIf { candidate -> list().any { it.id == candidate } } ?: DEFAULT_SKIN_ID
  }

  fun selected(): BubbleSkin = list().first { it.id == selectedId() }

  fun setSizeDp(id: String, sizeDp: Int): BubbleSkin {
    require(sizeDp in MIN_SIZE_DP..MAX_SIZE_DP) { "悬浮球大小必须在 $MIN_SIZE_DP–$MAX_SIZE_DP dp 之间" }
    val skin = list().firstOrNull { it.id == id } ?: throw IllegalArgumentException("找不到指定的悬浮球装扮")
    val sizes = readSizeSettings().put(id, sizeDp)
    check(preferences.edit().putString(KEY_SKIN_SIZES, sizes.toString()).commit()) { "无法保存悬浮球大小" }
    return skin.copy(sizeDp = sizeDp)
  }

  private fun readSizeSettings(): JSONObject = JSONObject(preferences.getString(KEY_SKIN_SIZES, "{}") ?: "{}")

  private fun withSize(skin: BubbleSkin, sizes: JSONObject = readSizeSettings()): BubbleSkin =
    skin.copy(sizeDp = if (sizes.has(skin.id)) sizes.getInt(skin.id) else DEFAULT_SIZE_DP)

  /**
   * 备份专用严格导出。
   *
   * 与日常 `list()` / `selectedId()` 的 UI 容错语义相反：这里直接读取 persisted metadata，
   * malformed JSON、非法条目、指向不存在文件的条目、重复 id、无效 selectedId 一律抛出，
   * 不允许跳过损坏项，也不允许把无效 selectedId 静默降级成默认装扮。
   * 只有这样 backup 才不会生成"缩水后仍然成功"的备份。
   *
   * 产出的 items 与 `parseBackup` 使用同一套契约（id / name / mimeType / fileName），
   * 因此恢复侧不需要第二套解析逻辑。
   */
  fun exportBackupStrict(): String {
    val skins = readPersistedCustomSkinsStrict()
    val selected = preferences.getString(KEY_SELECTED_ID, DEFAULT_SKIN_ID) ?: DEFAULT_SKIN_ID
    require((BUILTIN_SKINS + skins).any { it.id == selected }) { "悬浮球装扮选择无效" }
    val sizes = readSizeSettings()
    validateSkinSizes(sizes, (BUILTIN_SKINS + skins).map { it.id }.toSet())

    val items = JSONArray()
    skins.forEach { skin ->
      items.put(JSONObject().apply {
        put("id", skin.id)
        put("name", skin.name)
        put("mimeType", skin.mimeType)
        put("fileName", File(requireNotNull(skin.filePath)).name)
        skin.dockedFilePath?.let {
          put("dockedFileName", File(it).name)
          put("dockedMimeType", skin.dockedMimeType)
        }
      })
    }
    return JSONObject()
      .put("schemaVersion", 2)
      .put("selectedId", selected)
      .put("skinSizes", sizes)
      .put("items", items)
      .toString()
  }

  /** 文件由 Backup 冷启动阶段先恢复到固定目录；本 owner 只校验并重建自身 metadata。 */
  fun restoreBackup(encoded: String) {
    val restored = parseBackup(
      encoded,
      File(context.filesDir, SKIN_DIRECTORY),
    )
    // 三项事实共享一次 preferences commit，恢复不暴露半套外观状态。
    writeCustomSkins(restored.skins, restored.selectedId, restored.sizes)
  }

  /** 恢复替换发生前，在 staging 目录按与正式恢复相同的契约完成验证。 */
  fun validateBackup(encoded: String, rootUri: String) {
    val uri = Uri.parse(rootUri)
    require(uri.scheme == "file" && uri.path != null) { "悬浮球装扮备份目录无效" }
    parseBackup(encoded, File(requireNotNull(uri.path)))
  }

  private data class SkinBackup(val skins: List<BubbleSkin>, val selectedId: String, val sizes: JSONObject)

  private fun parseBackup(encoded: String, directory: File): SkinBackup {
    val backup = JSONObject(encoded)
    val version = backup.getInt("schemaVersion")
    require(version in 1..2) { "不支持的悬浮球装扮备份版本" }
    val items = backup.getJSONArray("items")
    require(items.length() <= MAX_CUSTOM_SKINS) { "悬浮球装扮备份数量超限" }
    val restoredIds = mutableSetOf<String>()
    val restored = buildList {
      for (index in 0 until items.length()) {
        val item = items.getJSONObject(index)
        val id = item.getString("id")
        require(id.startsWith("user-") && id.length <= 64) { "悬浮球装扮标识无效" }
        require(restoredIds.add(id)) { "悬浮球装扮标识重复" }
        val mimeType = item.getString("mimeType")
        require(mimeType in setOf(MIME_SVG, MIME_PNG, MIME_JPEG)) { "悬浮球装扮类型无效" }
        val fileName = item.getString("fileName")
        require(matchesAssetName(fileName, id)) {
          "悬浮球装扮文件名无效"
        }
        val file = File(directory, fileName)
        require(file.isFile) { "悬浮球装扮文件缺失" }
        val extension = fileName.substringAfterLast('.')
        require(extension in setOf("svg", "png", "jpg")) { "悬浮球装扮扩展名无效" }
        require(mimeTypeForExtension(extension) == mimeType) { "悬浮球装扮类型与扩展名不一致" }
        validateFile(file, extension)
        val dockedFile = if (item.has("dockedFileName")) {
          validateStoredAsset(directory, item.getString("dockedFileName"), "$id-docked", item.getString("dockedMimeType"))
        } else null
        add(BubbleSkin(
          id, normalizeName(item.getString("name")), BubbleSkinSource.USER, mimeType, file.path,
          dockedFilePath = dockedFile?.path,
          dockedMimeType = dockedFile?.let { item.getString("dockedMimeType") },
        ))
      }
    }
    val persistedSelected = backup.getString("selectedId")
    val selectedId = if (persistedSelected in RETIRED_BUILTIN_IDS) DEFAULT_SKIN_ID else persistedSelected
    require((BUILTIN_SKINS + restored).any { it.id == selectedId }) { "悬浮球装扮选择无效" }
    val allIds = (BUILTIN_SKINS + restored).map { it.id }.toSet()
    val sizes = if (version == 2) backup.getJSONObject("skinSizes") else {
      val globalSize = if (backup.has("sizeDp")) backup.getInt("sizeDp") else DEFAULT_SIZE_DP
      require(globalSize in MIN_SIZE_DP..MAX_SIZE_DP) { "悬浮球大小无效" }
      JSONObject().apply { allIds.forEach { put(it, globalSize) } }
    }
    validateSkinSizes(sizes, allIds)
    return SkinBackup(restored, selectedId, sizes)
  }

  fun backupRootUri(): String = Uri.fromFile(skinDirectory()).toString()

  /** 本 owner 唯一允许存放自定义装扮文件的目录；strict export 据此做 canonical 归属校验。 */
  private fun skinDirectory(): File = File(context.filesDir, SKIN_DIRECTORY)

  fun select(id: String): BubbleSkin {
    val skin = list().firstOrNull { it.id == id }
      ?: throw IllegalArgumentException("找不到指定的 RavenCat 悬浮球装扮")
    check(preferences.edit().putString(KEY_SELECTED_ID, skin.id).commit()) {
      "无法保存 RavenCat 悬浮球装扮选择"
    }
    return skin
  }

  fun import(uriText: String, fileName: String, mimeType: String?, displayName: String): BubbleSkin {
    val currentSkins = readCustomSkins()
    require(currentSkins.size < MAX_CUSTOM_SKINS) { "最多只能保存 $MAX_CUSTOM_SKINS 套自定义装扮" }
    val normalizedName = normalizeName(displayName)
    val normalizedExtension = resolveExtension(fileName, mimeType)
    val directory = File(context.filesDir, SKIN_DIRECTORY).apply {
      check(exists() || mkdirs()) { "无法创建 RavenCat 装扮目录" }
    }
    val id = "user-${UUID.randomUUID()}"
    val temporaryFile = File(directory, "$id.tmp")
    val targetFile = File(directory, "$id.$normalizedExtension")

    try {
      copyImage(uriText, temporaryFile, normalizedExtension)
      check(temporaryFile.renameTo(targetFile)) { "无法保存 RavenCat 装扮文件" }
      val skin = BubbleSkin(
        id = id,
        name = normalizedName,
        source = BubbleSkinSource.USER,
        mimeType = mimeTypeForExtension(normalizedExtension),
        filePath = targetFile.absolutePath,
      )
      writeCustomSkins(currentSkins + skin, skin.id)
      return skin
    } catch (error: Exception) {
      temporaryFile.delete()
      targetFile.delete()
      throw error
    }
  }

  fun updateImage(id: String, form: String, uriText: String, fileName: String, mimeType: String?): BubbleSkin {
    require(form == "normal" || form == "docked") { "装扮形态无效" }
    val skins = readCustomSkins()
    val index = skins.indexOfFirst { it.id == id }
    require(index >= 0) { "只能修改自定义装扮的图片" }
    val skin = skins[index]
    val extension = resolveExtension(fileName, mimeType)
    val stem = if (form == "docked") "$id-docked" else id
    val temporaryFile = File(skinDirectory(), "$stem.tmp")
    // 每次替换拥有新的文件身份，原生解码与设置页图片缓存都不会继续使用旧内容。
    val targetFile = File(skinDirectory(), "$stem-${UUID.randomUUID()}.$extension")
    var committed = false
    try {
      copyImage(uriText, temporaryFile, extension)
      check(temporaryFile.renameTo(targetFile)) { "无法保存 RavenCat 装扮文件" }
      val updated = if (form == "docked") {
        skin.copy(dockedFilePath = targetFile.path, dockedMimeType = mimeTypeForExtension(extension))
      } else {
        skin.copy(filePath = targetFile.path, mimeType = mimeTypeForExtension(extension))
      }
      writeCustomSkins(skins.toMutableList().apply { set(index, updated) })
      committed = true
      val previousPath = if (form == "docked") skin.dockedFilePath else skin.filePath
      if (previousPath != null && previousPath != targetFile.path) File(previousPath).delete()
      return withSize(updated)
    } finally {
      temporaryFile.delete()
      if (!committed) targetFile.delete()
    }
  }

  private fun copyImage(uriText: String, target: File, extension: String) {
    context.contentResolver.openInputStream(Uri.parse(uriText)).use { input ->
      requireNotNull(input) { "无法读取所选装扮文件" }
      FileOutputStream(target).use { output ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var totalBytes = 0L
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          totalBytes += count
          require(totalBytes <= MAX_FILE_BYTES) { "装扮图片不能超过 5MB" }
          output.write(buffer, 0, count)
        }
      }
    }
    validateFile(target, extension)
  }

  fun rename(id: String, displayName: String): BubbleSkin {
    require(id != DEFAULT_SKIN_ID) { "内置装扮不能重命名" }
    val normalizedName = normalizeName(displayName)
    val skins = readCustomSkins()
    val index = skins.indexOfFirst { it.id == id }
    require(index >= 0) { "找不到指定的自定义装扮" }
    val updated = skins[index].copy(name = normalizedName)
    writeCustomSkins(skins.toMutableList().apply { set(index, updated) })
    return withSize(updated)
  }

  fun delete(id: String) {
    require(id != DEFAULT_SKIN_ID) { "内置装扮不能删除" }
    val skins = readCustomSkins()
    val skin = skins.firstOrNull { it.id == id }
      ?: throw IllegalArgumentException("找不到指定的自定义装扮")
    val wasSelected = preferences.getString(KEY_SELECTED_ID, DEFAULT_SKIN_ID) == id
    val sizes = readSizeSettings().apply { remove(id) }
    writeCustomSkins(skins.filterNot { it.id == id }, if (wasSelected) DEFAULT_SKIN_ID else null, sizes)
    File(requireNotNull(skin.filePath)).delete()
    skin.dockedFilePath?.let { File(it).delete() }
  }

  /** 恢复出厂：删除全部自定义装扮文件与目录，清空装扮设置并恢复默认装扮。 */
  fun clearAllForFactoryReset() {
    val skins = readCustomSkins()

    skins.forEach { skin ->
      skin.filePath?.let { path ->
        check(!File(path).exists() || File(path).delete()) {
          "无法删除 RavenCat 自定义装扮文件: $path"
        }
      }
    }

    val directory = File(context.filesDir, SKIN_DIRECTORY)
    if (directory.exists()) {
      check(directory.deleteRecursively()) {
        "无法删除 RavenCat 自定义装扮目录"
      }
    }

    check(preferences.edit().clear().commit()) {
      "无法清空 RavenCat 装扮设置"
    }

    check(preferences.edit().putString(KEY_SELECTED_ID, DEFAULT_SKIN_ID).commit()) {
      "无法恢复 RavenCat 默认装扮"
    }
  }

  fun drawableFor(skin: BubbleSkin, docked: Boolean, targetEdgePx: Int = TARGET_BITMAP_EDGE): Drawable {
    val usesDockedAsset = docked && skin.hasDockedAsset
    val rawResource = skin.normalRawResource
    if (!usesDockedAsset && rawResource != null) {
      return bitmapDrawable({ context.resources.openRawResource(rawResource) }, targetEdgePx)
    }

    val file = File(requireNotNull(if (usesDockedAsset) skin.dockedFilePath else skin.filePath))
    return if ((if (usesDockedAsset) skin.dockedMimeType else skin.mimeType) == MIME_SVG) {
      file.inputStream().use { input ->
        svgDrawable(SVG.getFromInputStream(input), targetEdgePx)
      }
    } else {
      bitmapDrawable({ file.inputStream() }, targetEdgePx)
    }
  }

  private fun bitmapDrawable(openInput: () -> InputStream, targetEdgePx: Int): Drawable {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    openInput().use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "无法解析装扮图片" }
    var sampleSize = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sampleSize * 2) >= targetEdgePx) sampleSize *= 2
    val bitmap = openInput().use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sampleSize })
    } ?: throw IllegalArgumentException("无法解析装扮图片")
    bitmap.prepareToDraw()
    return BitmapDrawable(context.resources, bitmap)
  }

  private fun svgDrawable(svg: SVG, targetEdgePx: Int): Drawable {
    // 自定义 SVG 按实际窗口尺寸栅格化一次，拖动时只绘制缓存位图。
    val bitmap = Bitmap.createBitmap(targetEdgePx, targetEdgePx, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).drawPicture(svg.renderToPicture(targetEdgePx, targetEdgePx))
    bitmap.prepareToDraw()
    return BitmapDrawable(context.resources, bitmap)
  }

  private fun readCustomSkins(): List<BubbleSkin> {
    val encoded = preferences.getString(KEY_CUSTOM_SKINS, "[]") ?: "[]"
    val json = JSONArray(encoded)
    return buildList {
      for (index in 0 until json.length()) {
        val item = json.getJSONObject(index)
        val path = item.getString("filePath")
        if (File(path).isFile) {
          add(BubbleSkin(
            id = item.getString("id"),
            name = item.getString("name"),
            source = BubbleSkinSource.USER,
            mimeType = item.getString("mimeType"),
            filePath = path,
            dockedFilePath = item.optString("dockedFilePath").takeIf { it.isNotEmpty() },
            dockedMimeType = item.optString("dockedMimeType").takeIf { it.isNotEmpty() },
          ))
        }
      }
    }
  }

  /**
   * 备份专用严格读取 persisted metadata（`filePath` 形态），不跳过任何条目。
   *
   * 校验项与 `parseBackup` 的恢复契约保持一一对应，差别只在 persisted 使用绝对 filePath、
   * 备份使用 backing 目录内的 fileName。
   */
  private fun readPersistedCustomSkinsStrict(): List<BubbleSkin> {
    val encoded = preferences.getString(KEY_CUSTOM_SKINS, "[]") ?: "[]"
    val json = JSONArray(encoded)
    require(json.length() <= MAX_CUSTOM_SKINS) { "悬浮球装扮数量超限" }
    val seenIds = mutableSetOf<String>()
    return buildList {
      for (index in 0 until json.length()) {
        val item = json.getJSONObject(index)
        val id = item.getString("id")
        require(id.startsWith("user-") && id.length <= 64) { "悬浮球装扮标识无效" }
        require(seenIds.add(id)) { "悬浮球装扮标识重复" }
        val mimeType = item.getString("mimeType")
        require(mimeType in setOf(MIME_SVG, MIME_PNG, MIME_JPEG)) { "悬浮球装扮类型无效" }

        // persisted filePath 必须真的是本 owner 目录里的普通文件。
        //
        // 打包阶段只遍历固定的 bubbleSkinRoot，metadata 指向 root 之外的文件不会被收进备份；
        // 因此这里必须校验 canonical 归属，否则一条"root 外同名合法文件"的 metadata 会让
        // strict export 误报成功，产物却缺文件，直到 restore preflight 才暴露。
        val persistedFile = File(item.getString("filePath"))
        require(!Files.isSymbolicLink(persistedFile.toPath())) { "悬浮球装扮文件不能是软链接" }
        val file = persistedFile.canonicalFile
        require(file.parentFile == skinDirectory().canonicalFile) { "悬浮球装扮文件不属于装扮目录" }
        require(Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) { "悬浮球装扮文件缺失" }

        val fileName = file.name
        require(matchesAssetName(fileName, id)) { "悬浮球装扮文件名无效" }
        val extension = fileName.substringAfterLast('.')
        require(extension in setOf("svg", "png", "jpg")) { "悬浮球装扮扩展名无效" }
        require(mimeTypeForExtension(extension) == mimeType) { "悬浮球装扮类型与扩展名不一致" }
        validateFile(file, extension)

        val dockedFile = if (item.has("dockedFilePath")) {
          val persistedDocked = File(item.getString("dockedFilePath"))
          require(!Files.isSymbolicLink(persistedDocked.toPath())) { "悬浮球装扮文件不能是软链接" }
          require(persistedDocked.canonicalFile.parentFile == skinDirectory().canonicalFile) { "悬浮球装扮文件不属于装扮目录" }
          validateStoredAsset(skinDirectory(), persistedDocked.name, "$id-docked", item.getString("dockedMimeType"))
        } else null

        add(BubbleSkin(
          id = id,
          name = normalizeName(item.getString("name")),
          source = BubbleSkinSource.USER,
          mimeType = mimeType,
          filePath = file.path,
          dockedFilePath = dockedFile?.path,
          dockedMimeType = dockedFile?.let { item.getString("dockedMimeType") },
        ))
      }
    }
  }

  private fun writeCustomSkins(skins: List<BubbleSkin>, selectedId: String? = null, sizes: JSONObject? = null) {
    val json = JSONArray()
    skins.forEach { skin ->
      json.put(JSONObject().apply {
        put("id", skin.id)
        put("name", skin.name)
        put("mimeType", skin.mimeType)
        put("filePath", skin.filePath)
        skin.dockedFilePath?.let {
          put("dockedFilePath", it)
          put("dockedMimeType", skin.dockedMimeType)
        }
      })
    }
    val editor = preferences.edit().putString(KEY_CUSTOM_SKINS, json.toString())
    selectedId?.let { editor.putString(KEY_SELECTED_ID, it) }
    sizes?.let { editor.putString(KEY_SKIN_SIZES, it.toString()) }
    check(editor.commit()) {
      "无法保存 RavenCat 自定义装扮"
    }
  }

  private fun validateSkinSizes(sizes: JSONObject, skinIds: Set<String>) {
    sizes.keys().forEach { id ->
      require(id in skinIds) { "大小设置指向不存在的悬浮球装扮" }
      require(sizes.getInt(id) in MIN_SIZE_DP..MAX_SIZE_DP) { "悬浮球大小无效" }
    }
  }

  private fun validateStoredAsset(directory: File, fileName: String, stem: String, mimeType: String): File {
    require(matchesAssetName(fileName, stem)) { "悬浮球装扮文件名无效" }
    val extension = fileName.substringAfterLast('.')
    require(extension in setOf("svg", "png", "jpg") && mimeTypeForExtension(extension) == mimeType) { "悬浮球装扮类型与扩展名不一致" }
    val file = File(directory, fileName)
    require(Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) { "悬浮球装扮文件缺失" }
    validateFile(file, extension)
    return file
  }

  private fun matchesAssetName(fileName: String, stem: String): Boolean {
    if ('/' in fileName || '\\' in fileName) return false
    val actualStem = fileName.substringBeforeLast('.')
    return actualStem == stem || Regex("${Regex.escape(stem)}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(actualStem)
  }

  private fun validateFile(file: File, extension: String) {
    require(file.length() in 1..MAX_FILE_BYTES) { "装扮图片为空或超过 5MB" }
    if (extension == "svg") {
      val source = file.readText(Charsets.UTF_8)
      val normalized = source.lowercase()
      require(normalized.contains("<svg")) { "所选文件不是有效的 SVG" }
      val forbiddenTokens = listOf("<!doctype", "<!entity", "<script", "href=\"http", "href='http")
      require(forbiddenTokens.none(normalized::contains)) { "SVG 包含不支持的外部内容" }
      SVG.getFromString(source)
      return
    }

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    require(bounds.outMimeType in setOf(MIME_PNG, MIME_JPEG)) { "所选文件不是有效的 PNG 或 JPG" }
    require(bounds.outWidth in 1..MAX_BITMAP_EDGE && bounds.outHeight in 1..MAX_BITMAP_EDGE) {
      "装扮图片边长不能超过 ${MAX_BITMAP_EDGE}px"
    }
  }

  private fun resolveExtension(fileName: String, mimeType: String?): String {
    val extension = fileName.substringAfterLast('.', "").lowercase()
    val byMimeType = when (mimeType?.lowercase()) {
      MIME_SVG -> "svg"
      MIME_PNG -> "png"
      MIME_JPEG, "image/jpg" -> "jpg"
      else -> null
    }
    val resolved = byMimeType ?: extension
    require(resolved in setOf("svg", "png", "jpg", "jpeg")) { "仅支持 SVG、PNG 和 JPG 图片" }
    return if (resolved == "jpeg") "jpg" else resolved
  }

  private fun mimeTypeForExtension(extension: String): String = when (extension) {
    "svg" -> MIME_SVG
    "png" -> MIME_PNG
    else -> MIME_JPEG
  }

  private fun normalizeName(value: String): String {
    val normalized = value.trim()
    require(normalized.isNotEmpty()) { "装扮名称不能为空" }
    require(normalized.length <= MAX_NAME_LENGTH) { "装扮名称不能超过 $MAX_NAME_LENGTH 个字符" }
    return normalized
  }

  companion object {
    const val DEFAULT_SKIN_ID = "builtin-minimal"
    private val RETIRED_BUILTIN_IDS = setOf("builtin-blue-ball", "builtin-orange-crab")
    private const val PREFERENCES_NAME = "ravencat_bubble_skins"
    private const val KEY_SELECTED_ID = "selected_id"
    private const val KEY_CUSTOM_SKINS = "custom_skins"
    private const val KEY_LEGACY_SIZE_DP = "size_dp"
    private const val KEY_SKIN_SIZES = "skin_sizes"
    const val DEFAULT_SIZE_DP = 56
    const val MIN_SIZE_DP = 32
    const val MAX_SIZE_DP = 96
    private const val SKIN_DIRECTORY = "ravencat/bubble-skins"
    private const val MAX_CUSTOM_SKINS = 20
    private const val MAX_NAME_LENGTH = 30
    private const val MAX_FILE_BYTES = 5L * 1024 * 1024
    private const val MAX_BITMAP_EDGE = 4096
    private const val TARGET_BITMAP_EDGE = 512
    private const val MIME_SVG = "image/svg+xml"
    private const val MIME_PNG = "image/png"
    private const val MIME_JPEG = "image/jpeg"

    private val BUILTIN_SKINS = listOf(
      BubbleSkin(
        id = DEFAULT_SKIN_ID,
        name = "鸦鸦",
        source = BubbleSkinSource.BUILTIN,
        mimeType = MIME_PNG,
        normalRawResource = R.raw.ravencat_yaya,
      ),
    )
  }
}
