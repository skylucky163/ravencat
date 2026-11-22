export interface ConnectionTestOptions {
  disableThinking?: boolean;
  reasoningEffort?: import('@platform/ai').ReasoningEffort;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  skipParams?: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  error: string | null;
}

export interface ParamErrorInfo {
  isParamError: boolean;
  paramName: string | null;
  allowedValue: string | null;
  message: string;
}

export interface ErrorDisplayInfo {
  title: string;
  message: string;
  type?: string;
  isParamError?: boolean;
  paramName?: string | null;
  allowedValue?: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}
