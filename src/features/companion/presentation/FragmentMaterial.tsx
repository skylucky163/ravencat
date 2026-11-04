/** 静态照片与取景只随日期变化；手势只变换外层，不逐帧生成蒙版或材质。 */
import React, { memo, useId } from 'react';
import Svg, { Defs, Image, Mask } from 'react-native-svg';
import type { FragmentTexture } from './fragmentTextures';

function FragmentMaterial({ texture }: { texture: FragmentTexture }) {
  const maskId = useId();
  const [x, y, width, height] = texture.crop;
  const image = { href: texture.source, x: 0, y: 0, width: texture.width, height: texture.height };
  return <Svg pointerEvents="none" width={66} height={56} viewBox={`${x} ${y} ${width} ${height}`}>
    <Defs><Mask id={maskId} x={x} y={y} width={width} height={height} maskUnits="userSpaceOnUse" maskType="luminance"><Image {...image} /></Mask></Defs>
    <Image {...image} mask={`url(#${maskId})`} />
  </Svg>;
}

export default memo(FragmentMaterial);
