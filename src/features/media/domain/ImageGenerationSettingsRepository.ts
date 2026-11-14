export interface ImageGenerationSettingsRepository {
  getModelId(): Promise<string | null>;
  setModelId(id: string | null): Promise<void>;
}
