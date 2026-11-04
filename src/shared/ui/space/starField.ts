/** 星空在模块加载时固定采样，尺寸变化只投影视口，不重新洗牌。 */
function createStars(count: number, seed: number) {
  let state = seed;
  const random = () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    size: 0.35 + random() ** 3 * 1.65,
    brightness: random(),
    layer: Math.floor(random() * 3),
  }));
}

export const DISTANT_STARS = createStars(120, 0x52415645);
export const GALAXY_DUST = createStars(180, 0x4D454D4F);
const NEAR_STARS = createStars(28, 0x43415453);
export const NEAR_STAR_LAYERS = Array.from({ length: 3 }, (_, layer) => NEAR_STARS.filter(star => star.layer === layer));
export type GalaxyStar = typeof NEAR_STARS[number];
