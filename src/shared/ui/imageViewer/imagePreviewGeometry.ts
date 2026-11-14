/** 预览视口中的等比尺寸与拖动边界；手势和尺寸变化共用同一几何规则。 */
export function fitPreviewImage(width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const ratio = Math.min(viewportWidth / width, viewportHeight / height);
  return { width: width * ratio, height: height * ratio };
}

export function clampPreviewOffset(offset: number, imageLength: number, viewportLength: number, scale: number) {
  'worklet';
  const limit = Math.max(0, (imageLength * scale - viewportLength) / 2);
  return Math.max(-limit, Math.min(offset, limit));
}
