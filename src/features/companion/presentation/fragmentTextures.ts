/** 真实星体素材及已校准的取景；日期分配不修改源照片。 */
import type { ImageSourcePropType } from 'react-native';

export interface FragmentTexture {
  id: string;
  name: string;
  source: ImageSourcePropType;
  width: number;
  height: number;
  crop: readonly [number, number, number, number];
}

export const FRAGMENT_TEXTURES: readonly FragmentTexture[] = [
  { id: "eros", name: "Eros", source: require('./assets/fragments/eros.jpg'), width: 256, height: 192, crop: [38, 0, 184, 192] },
  { id: "arrokoth", name: "Arrokoth", source: require('./assets/fragments/arrokoth.png'), width: 179, height: 256, crop: [0, 0, 179, 256] },
  { id: "mathilde", name: "Mathilde", source: require('./assets/fragments/mathilde.jpg'), width: 256, height: 139, crop: [78, 29, 105, 103] },
  { id: "itokawa", name: "Itokawa", source: require('./assets/fragments/itokawa.jpg'), width: 256, height: 136, crop: [0, 0, 256, 126] },
  { id: "wild", name: "Wild 2", source: require('./assets/fragments/wild.jpg'), width: 256, height: 113, crop: [0, 0, 128, 113] },
  { id: "gaspra", name: "Gaspra", source: require('./assets/fragments/gaspra.jpg'), width: 175, height: 256, crop: [97, 27, 77, 80] },
  { id: "phobos", name: "Phobos", source: require('./assets/fragments/phobos.jpg'), width: 256, height: 160, crop: [56, 8, 153, 148] },
  { id: "churyumov", name: "67P", source: require('./assets/fragments/churyumov-card.png'), width: 333, height: 250, crop: [31, 0, 267, 211] },
  { id: "ida", name: "Ida", source: require('./assets/fragments/ida.jpg'), width: 256, height: 185, crop: [46, 27, 127, 111] },
  { id: "bennu", name: "Bennu", source: require('./assets/fragments/bennu.jpg'), width: 256, height: 242, crop: [0, 0, 256, 242] },
  { id: "borrelly", name: "Borrelly", source: require('./assets/fragments/borrelly.jpg'), width: 432, height: 244, crop: [154, 75, 143, 110] },
  { id: "deimos", name: "Deimos", source: require('./assets/fragments/deimos.jpg'), width: 256, height: 182, crop: [35, 0, 189, 177] },
  { id: "hartley", name: "Hartley 2", source: require('./assets/fragments/hartley.jpg'), width: 256, height: 144, crop: [41, 0, 155, 144] },
  { id: "lutetia", name: "Lutetia", source: require('./assets/fragments/lutetia.jpg'), width: 256, height: 192, crop: [60, 0, 156, 192] },
];
