import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { assertChatAttachmentSize, isChatImageFile } from './chatAttachmentSelection';

export interface SelectedChatDocument {
  type: 'image' | 'file';
  uri: string;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  source: 'document';
}

export async function selectChatDocument(): Promise<SelectedChatDocument | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: false,
    copyToCacheDirectory: true,
    type: '*/*',
  });

  if (result.canceled || !result.assets?.length) {
    return null;
  }

  const asset = result.assets[0];
  const fileName = asset.name || `document_${Date.now()}`;
  const type = isChatImageFile(fileName, asset.mimeType) ? 'image' : 'file';
  const fileSize = new File(asset.uri).size;
  assertChatAttachmentSize(fileSize, type);

  return {
    type,
    uri: asset.uri,
    fileName,
    mimeType: asset.mimeType || null,
    fileSize,
    source: 'document',
  };
}
