package expo.modules.messagebubble

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NineSliceRendererTest {
  @Test fun cornersTransparencyAndDynamicHeight() {
    val source = Bitmap.createBitmap(9, 9, Bitmap.Config.ARGB_8888)
    source.eraseColor(Color.WHITE)
    for (y in 0..2) for (x in 0..2) source.setPixel(x, y, Color.RED)
    for (y in 6..8) for (x in 6..8) source.setPixel(x, y, Color.BLUE)
    source.setPixel(0, 0, Color.TRANSPARENT)
    val renderer = NineSliceRenderer()
    for (height in listOf(12, 48, 240)) {
      val target = Bitmap.createBitmap(48, height, Bitmap.Config.ARGB_8888)
      renderer.draw(Canvas(target), source, 48, height, 3, 3, 3, 3, 1f)
      assertEquals(0, Color.alpha(target.getPixel(0, 0)))
      assertEquals(Color.RED, target.getPixel(1, 1))
      assertEquals(Color.BLUE, target.getPixel(46, height - 2))
      assertEquals(Color.WHITE, target.getPixel(24, height / 2))
      // 任意高度下中线没有九宫格之间的透明裂缝。
      for (y in 0 until height) assertEquals(255, Color.alpha(target.getPixel(24, y)))
    }
  }

  @Test fun decodingIsSharedAndRejectsInvalidFiles() {
    val image = Bitmap.createBitmap(12, 12, Bitmap.Config.ARGB_8888)
    val file = File.createTempFile("bubble-cache-", ".png")
    try {
      file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
      val uri = file.toURI().toString()
      assertEquals(Looper.getMainLooper(), Looper.myLooper())
      val first = BubbleBitmapCache.load(uri)
      val second = BubbleBitmapCache.load(uri)
      assertSame(first.get(10, TimeUnit.SECONDS), second.get(10, TimeUnit.SECONDS))
      assertSame(first.get(), BubbleBitmapCache.load(uri).get())
      val invalid = File.createTempFile("bubble-invalid-", ".png")
      try {
        invalid.writeText("invalid")
        val error = assertThrows(java.util.concurrent.ExecutionException::class.java) {
          BubbleBitmapCache.load(invalid.toURI().toString()).get(10, TimeUnit.SECONDS)
        }
        assertEquals("气泡图片无法解码，文件可能已损坏", error.cause!!.message)
      } finally { invalid.delete() }
    } finally { file.delete() }
  }

  @Test fun smallPngReportsDimensionError() {
    val image = Bitmap.createBitmap(2, 12, Bitmap.Config.ARGB_8888)
    val file = File.createTempFile("bubble-small-", ".png")
    try {
      file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
      val error = assertThrows(java.util.concurrent.ExecutionException::class.java) {
        BubbleBitmapCache.load(file.toURI().toString()).get(10, TimeUnit.SECONDS)
      }
      assertEquals("气泡图片边长需为 3–2048 像素", error.cause!!.message)
    } finally { file.delete() }
  }
}
