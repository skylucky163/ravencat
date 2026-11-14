package expo.modules.gallerywriter

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.system.ErrnoException
import android.system.OsConstants
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class GalleryImageStoreTest {
  private lateinit var context: Context
  private lateinit var provider: GalleryTestProvider
  private lateinit var store: GalleryImageStore
  @Before fun prepare() {
    context = RuntimeEnvironment.getApplication()
    provider = GalleryTestProvider()
    provider.attachInfo(context, ProviderInfo().apply { authority = "media" })
    ShadowContentResolver.registerProviderInternal("media", provider)
    store = GalleryImageStore(context.contentResolver)
  }
  @Test fun savesOriginalFormatsAndPublishesOnlyAfterCopy() {
    for (mime in listOf("image/png", "image/jpeg", "image/gif", "image/webp")) {
      val source = File(context.cacheDir, "source").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
      val result = store.save(source, mime, "image", GalleryWriteRequest())
      assertEquals("content://media/external/images/media/1", result["uri"])
      assertEquals("actual-name", result["fileName"])
      assertArrayEquals(source.readBytes(), provider.destination.readBytes())
      assertEquals(mime, provider.inserted.getAsString(MediaStore.Images.Media.MIME_TYPE))
      assertEquals("Pictures/RavenCat", provider.inserted.getAsString(MediaStore.Images.Media.RELATIVE_PATH))
      assertEquals(1, provider.inserted.getAsInteger(MediaStore.Images.Media.IS_PENDING))
      assertTrue(provider.published)
      assertEquals(0, provider.deleted)
    }
  }
  @Test fun interruptionBeforePublishDeletesPendingImage() {
    val request = GalleryWriteRequest()
    provider.onQuery = { request.cancel() }
    val error = assertThrows(GalleryWriteFailure::class.java) {
      store.save(File(context.cacheDir, "source").apply { writeText("image") }, "image/gif", "x.gif", request)
    }
    assertEquals("GALLERY_INTERRUPTED", error.code)
    assertFalse(provider.published)
    assertEquals(1, provider.deleted)
  }
  @Test fun failedPublicationDeletesPendingImage() {
    provider.failPublication = true
    assertThrows(GalleryWriteFailure::class.java) {
      store.save(File(context.cacheDir, "source").apply { writeText("image") }, "image/png", "x.png", GalleryWriteRequest())
    }
    assertEquals(1, provider.deleted)
  }
  @Test fun rejectsUnwritableDirectoryAndAlreadyCancelledRequest() {
    provider.writable = false
    val file = File(context.cacheDir, "source").apply { writeText("image") }
    assertEquals("GALLERY_NOT_WRITABLE", assertThrows(GalleryWriteFailure::class.java) {
      store.save(file, "image/png", "x.png", GalleryWriteRequest())
    }.code)
    val request = GalleryWriteRequest().apply { cancel() }
    assertEquals("GALLERY_INTERRUPTED", assertThrows(GalleryWriteFailure::class.java) { store.save(file, "image/png", "x.png", request) }.code)
  }
  @Test fun distinguishesStorageFailuresFromInterruptedWrites() {
    assertEquals("GALLERY_NO_SPACE", classifyGalleryFailure(IOException("write", ErrnoException("write", OsConstants.ENOSPC))).code)
    assertEquals("GALLERY_NO_SPACE", classifyGalleryFailure(IOException("write", ErrnoException("write", OsConstants.EDQUOT))).code)
    assertEquals("GALLERY_NOT_WRITABLE", classifyGalleryFailure(SecurityException()).code)
    assertEquals("GALLERY_NOT_WRITABLE", classifyGalleryFailure(IOException("write", ErrnoException("write", OsConstants.EROFS))).code)
    assertEquals("GALLERY_INTERRUPTED", classifyGalleryFailure(IOException("interrupted")).code)
  }
}

class GalleryTestProvider : ContentProvider() {
  lateinit var destination: File
  lateinit var inserted: ContentValues
  var writable = true
  var published = false
  var deleted = 0
  var failPublication = false
  var onQuery: (() -> Unit)? = null
  override fun onCreate() = true
  override fun getType(uri: Uri) = "image/png"
  override fun insert(uri: Uri, values: ContentValues?): Uri? {
    if (!writable) return null
    inserted = ContentValues(values)
    destination = File(context!!.filesDir, "gallery-output")
    return Uri.parse("content://media/external/images/media/1")
  }
  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = ParcelFileDescriptor.open(destination,
    ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE)
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
    onQuery?.invoke()
    return MatrixCursor(arrayOf(MediaStore.Images.Media.DISPLAY_NAME)).apply { addRow(arrayOf("actual-name")) }
  }
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
    if (failPublication) return 0
    published = true
    return 1
  }
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int { deleted++; destination.delete(); return 1 }
}
