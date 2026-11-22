import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { assertChatAttachmentSize } from './chatAttachmentSelection';

export interface CapturedChatPhoto {
  uri: string;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  source: 'camera';
}

export async function captureChatPhoto(): Promise<CapturedChatPhoto | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('未获得相机权限，无法拍照');
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
  });

  if (result.canceled || !result.assets?.length) {
    return null;
  }

  const asset = result.assets[0];
  const fileSize = new File(asset.uri).size;
  assertChatAttachmentSize(fileSize, 'image');

  return {
    uri: asset.uri,
    fileName: asset.fileName || `camera_${Date.now()}.jpg`,
    mimeType: asset.mimeType || 'image/jpeg',
    fileSize,
    width: asset.width ?? null,
    height: asset.height ?? null,
    source: 'camera',
  };
}
