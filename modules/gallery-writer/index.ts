import { NativeModule, requireNativeModule } from 'expo-modules-core';

declare class GalleryWriterNative extends NativeModule {
  begin(id: string): void;
  cancel(id: string): void;
  save(id: string, uri: string, mimeType: string, fileName: string): Promise<{ uri: string; fileName: string }>;
}
export const nativeGalleryWriter = requireNativeModule<GalleryWriterNative>('GalleryWriter');
