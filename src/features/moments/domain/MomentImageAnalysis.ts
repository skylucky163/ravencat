/** Moments 图片理解只引用辅助模型中心配置，不拥有连接密钥。 */
export interface MomentImageAnalysisModelRef {
  id: string;
  capabilityKind: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

export type MomentImageAnalysisModelSelectionStatus =
  | 'unconfigured'
  | 'active'
  | 'incomplete'
  | 'deleted'
  | 'capability_mismatch';

export interface MomentImageAnalysisModelSelection {
  modelConfigId: string | null;
  status: MomentImageAnalysisModelSelectionStatus;
  name: string | null;
  model: string | null;
}

export type MomentImageAnalysisErrorCode =
  | 'model_not_configured'
  | 'model_unavailable'
  | 'media_unavailable'
  | 'model_request_failed'
  | 'empty_analysis'
  | 'stale_analysis_attempt';

export class MomentImageAnalysisError extends Error {
  constructor(public readonly code: MomentImageAnalysisErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MomentImageAnalysisError';
  }
}
