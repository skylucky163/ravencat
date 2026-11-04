/**
 * 凹槽贝塞尔曲线参考 react-native-fluid-bottom-bar / CurveSVG 后重新调整比例。
 * Copyright (c) 2026 Vipin Sharma / Copyright (c) 2024 Moeen Mahmud?
 * MIT 许可原文见 docs/third-party/upstream/。
 */
export const SCOOPED_BAR_TOP = 20;

export function buildScoopedBarPath(cx: number, width: number, height: number, half: number): string {
  'worklet';
  const top = SCOOPED_BAR_TOP;
  const bottom = top + 32;
  return `M 0 ${top} H ${cx - half}
    C ${cx - half * 0.63} ${top}, ${cx - half * 0.68} ${bottom}, ${cx} ${bottom}
    C ${cx + half * 0.68} ${bottom}, ${cx + half * 0.63} ${top}, ${cx + half} ${top}
    H ${width} V ${height} H 0 Z`;
}
