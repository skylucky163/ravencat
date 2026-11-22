import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';

declare class CachedZipReader extends NativeModule {
  readText(archiveUri: string, name: string, limit: number): Promise<string | null>;
  extract(archiveUri: string, name: string, targetUri: string, limit: number): Promise<number | null>;
}

export function getCachedZipReader() {
  return requireOptionalNativeModule<CachedZipReader>('RavenCatZipReader');
}
