package expo.modules.messagebubble

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect

/** 共用整数目标边界，避免九块分别取整造成缝隙；直接绘制共享原图，不创建目标位图。 */
internal class NineSliceRenderer {
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val source = Rect()
  private val destination = Rect()

  fun draw(canvas: Canvas, bitmap: Bitmap, width: Int, height: Int,
           left: Int, top: Int, right: Int, bottom: Int, pixelsPerSourcePixel: Float) {
    val x = intArrayOf(0, left, bitmap.width - right, bitmap.width)
    val y = intArrayOf(0, top, bitmap.height - bottom, bitmap.height)
    // RN 的最小尺寸保证固定边框可放下。布局过渡时尚未分配尺寸，不绘制反向矩形。
    val dl = kotlin.math.round(left * pixelsPerSourcePixel).toInt()
    val dr = kotlin.math.round(right * pixelsPerSourcePixel).toInt()
    val dt = kotlin.math.round(top * pixelsPerSourcePixel).toInt()
    val db = kotlin.math.round(bottom * pixelsPerSourcePixel).toInt()
    if (width < dl + dr || height < dt + db) return
    val dx = intArrayOf(0, dl, width - dr, width)
    val dy = intArrayOf(0, dt, height - db, height)
    for (row in 0..2) for (column in 0..2) {
      source.set(x[column], y[row], x[column + 1], y[row + 1])
      destination.set(dx[column], dy[row], dx[column + 1], dy[row + 1])
      if (!source.isEmpty && !destination.isEmpty) canvas.drawBitmap(bitmap, source, destination, paint)
    }
  }
}
