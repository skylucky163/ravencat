/** 日期弧线仅拥有几何与触摸布局，颜色沿用共享主题的星空对比度。 */
import { StyleSheet } from 'react-native';
import { getThemeById, type PresentationTheme } from '@shared/theme';

export const createStyles = (theme: PresentationTheme) => {
  const light = getThemeById('default-dark').colors.text.primary;
  return StyleSheet.create({
    heading: { marginHorizontal: 24, marginTop: 30, flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
    month: { color: light, opacity: 0.9, fontSize: 12, letterSpacing: 1 },
    weekday: { color: light, opacity: 0.65, fontSize: 12 },
    arc: { height: 250, overflow: 'hidden' },
    lights: { ...StyleSheet.absoluteFillObject },
    spark: { position: 'absolute', left: 0, top: 0, width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
    sparkHalo: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: theme.colors.brand.primary, opacity: 0.06 },
    sparkGlow: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: light, opacity: 0.12 },
    sparkCore: { width: 2, height: 2, borderRadius: 1, backgroundColor: light, opacity: 0.85 },
    node: { position: 'absolute', height: 98, alignItems: 'center' },
    rock: { width: 66, height: 56, alignItems: 'center' },
    date: { color: light, opacity: 0.72, fontSize: 12, marginTop: 8, fontVariant: ['tabular-nums'] },
    selectedDate: { color: light, opacity: 1, fontSize: 16 },
    count: { color: light, opacity: 0.65, fontSize: 11, marginTop: 4 },
    directions: { position: 'absolute', left: 24, right: 24, bottom: 0, flexDirection: 'row', justifyContent: 'space-between' },
    directionText: { color: light, opacity: 0.5, fontSize: 11, letterSpacing: 2 },
    navigation: { marginHorizontal: 16, marginBottom: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    // 导航条中间常驻「今天」：既是回到今天的入口，也用它自身的亮度标示当前是否停在今天。
    today: { color: light, opacity: 0.6, fontSize: 11, letterSpacing: 1 },
    todayActive: { opacity: 1 },
  });
};
