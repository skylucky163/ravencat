/** 碎片、轨迹和流光共用同一条开放弧线，避免动效与日期位置逐渐偏离。 */
export function dateArcY(x: number, width: number): number {
  'worklet';
  return 67 + (x - width / 2) ** 2 / (width * 1.08);
}
