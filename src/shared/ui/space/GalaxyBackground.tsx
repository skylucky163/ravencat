/** 星云纹理缓慢漂移，远星保持独立；固定图元预算，不随屏幕像素面积增长。 */
import React, { memo, useEffect, useId, useMemo } from 'react';
import { PixelRatio, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Defs, Ellipse, FeColorMatrix, Filter, Image, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { getThemeById, useTheme } from '@shared/theme';
import { DISTANT_STARS, GALAXY_DUST } from './starField';

function dot(x: number, y: number, radius: number) {
  return `M${x - radius},${y}a${radius},${radius} 0 1,0 ${radius * 2},0a${radius},${radius} 0 1,0 ${-radius * 2},0`;
}

function GalaxyBackground({ width, height, paused }: { width: number; height: number; paused: boolean }) {
  const id = useId();
  const theme = useTheme();
  const starlight = theme.mode === 'dark' ? theme.colors.text.primary : theme.colors.text.inverse;
  const spaceColor = getThemeById('default-dark').colors.background.app;
  // Android SVG 滤镜会分配多张画布大小的位图。尘埃纹理限制为最长边 512 物理像素，
  // 再由视图变换放大；远星仍按完整视口绘制，不跟随纹理降低精度。
  const textureScale = Math.min(1, 512 / (Math.max(width, height) * PixelRatio.get()));
  const textureWidth = width * textureScale;
  const textureHeight = height * textureScale;
  const drift = useSharedValue(0);
  // Screen 传入统一生命周期；只移动已着色纹理，不逐帧重算滤镜或模糊。
  useEffect(() => {
    if (!paused) drift.value = withRepeat(withTiming(drift.value + 1, { duration: 90000, easing: Easing.linear }), -1);
    return () => cancelAnimation(drift);
  }, [paused, drift]);
  const nebulaMotion = useAnimatedStyle<ViewStyle>(() => ({
    opacity: 0.25 + Math.sin(drift.value * Math.PI * 2) * 0.02,
    transform: [{ translateX: Math.sin(drift.value * Math.PI * 2) * 12 }, { translateY: Math.cos(drift.value * Math.PI * 2) * 16 }, { scale: 1.12 }] as const,
  }));
  const paths = useMemo(() => {
    const distant: string[] = [];
    const bright: string[] = [];
    const dust: string[] = [];
    for (const star of DISTANT_STARS) {
      (star.brightness > 0.8 ? bright : distant).push(dot(star.x * width, star.y * height, star.size));
    }
    for (const star of GALAXY_DUST) {
      const spread = (star.y - 0.5) * height * 0.25;
      dust.push(dot(star.x * width, height * (0.24 + star.x * 0.4) + spread, star.size * 0.4));
    }
    return { distant: distant.join(''), bright: bright.join(''), dust: dust.join('') };
  }, [width, height]);

  return <View style={StyleSheet.absoluteFill} pointerEvents="none">
    {/* 保留真实尘埃的明暗结构，冷色材质去掉原照片的红褐色。 */}
    <Animated.View style={[StyleSheet.absoluteFill, nebulaMotion]}>
      <View style={{ width: textureWidth, height: textureHeight, transformOrigin: 'top left', transform: [{ scale: 1 / textureScale }] }}>
        <Svg width={textureWidth} height={textureHeight} viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            <Filter id={`${id}-cool-nebula`} x="0%" y="0%" width="100%" height="100%">
              <FeColorMatrix type="matrix" values={[
                0.22, 0.36, 0.26, 0, 0,
                0.14, 0.22, 0.2, 0, 0,
                0.32, 0.52, 0.5, 0, 0,
                0, 0, 0, 1, 0,
              ]} />
            </Filter>
          </Defs>
          <Image href={require('./assets/orion-nebula.jpg')} width={width} height={height} preserveAspectRatio="xMidYMid slice" filter={`url(#${id}-cool-nebula)`} />
        </Svg>
      </View>
    </Animated.View>
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Defs>
        <RadialGradient id={`${id}-nebula-tint`} cx="50%" cy="50%" rx="50%" ry="50%">
          <Stop offset="0" stopColor={theme.colors.brand.primary} stopOpacity={0.09} />
          <Stop offset="0.45" stopColor={theme.colors.brand.primary} stopOpacity={0.04} />
          <Stop offset="1" stopColor={theme.colors.brand.primary} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={`${id}-nebula-vignette`} cx="50%" cy="48%" rx="70%" ry="65%">
          <Stop offset="0" stopColor={spaceColor} stopOpacity={0} />
          <Stop offset="0.55" stopColor={spaceColor} stopOpacity={0.12} />
          <Stop offset="1" stopColor={spaceColor} stopOpacity={0.8} />
        </RadialGradient>
      </Defs>
      {[0, 1, 2].map(i => <Ellipse key={i} cx={width * (0.08 + i * 0.44)} cy={height * (0.28 + i * 0.18)} rx={width * 0.65} ry={height * 0.22} fill={`url(#${id}-nebula-tint)`} />)}
      <Rect width={width} height={height} fill={`url(#${id}-nebula-vignette)`} />
      <Path d={paths.dust} fill={starlight} opacity={0.16} />
      <Path d={paths.distant} fill={starlight} opacity={0.35} />
      <Path d={paths.bright} fill={starlight} opacity={0.65} />
    </Svg>
  </View>;
}

export default memo(GalaxyBackground);
