import { createAIClient, getErrorDisplayInfo, testAPIConnection } from '@platform/ai';
import type {
  ConnectionTestOptions,
  ConnectionTestResult,
  ErrorDisplayInfo,
} from '@platform/ai';

export interface TestAuxiliaryModelConnectionParams {
  capabilityKind?: 'embedding' | 'ocr';
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  skipParams?: boolean;
}

export interface TestAuxiliaryModelConnectionResult {
  skipped: boolean;
  success: boolean;
  result?: ConnectionTestResult;
  rawError: string | null;
  errorInfo: ErrorDisplayInfo | null;
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '').trim();
}

function buildConnectionOptions(
  params: TestAuxiliaryModelConnectionParams
): ConnectionTestOptions {
  if (params.skipParams) {
    return { skipParams: true };
  }

  const options: ConnectionTestOptions = {};
  if (params.temperature !== null && params.temperature !== undefined) {
    options.temperature = params.temperature;
  }
  if (params.topP !== null && params.topP !== undefined) {
    options.topP = params.topP;
  }
  if (params.maxTokens !== null && params.maxTokens !== undefined) {
    options.maxTokens = params.maxTokens;
  }
  return options;
}

async function testEmbeddingConnection(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<ConnectionTestResult> {
  const client = createAIClient({
    baseURL: baseUrl,
    apiKey,
    model,
    temperature: null,
    topP: null,
    maxTokens: null,
  });
  const response = await client.embed('connection test');

  return {
    success: response.success,
    error: response.error,
  };
}

export async function testAuxiliaryModelConnection(
  params: TestAuxiliaryModelConnectionParams
): Promise<TestAuxiliaryModelConnectionResult> {
  const baseUrl = normalizeText(params.baseUrl);
  const apiKey = normalizeText(params.apiKey);
  const model = normalizeText(params.model);

  if (!baseUrl || !apiKey || !model) {
    return {
      skipped: true,
      success: false,
      rawError: null,
      errorInfo: null,
    };
  }

  try {
    const result = params.capabilityKind === 'embedding'
      ? await testEmbeddingConnection(baseUrl, apiKey, model)
      : await testAPIConnection(
        baseUrl,
        apiKey,
        model,
        buildConnectionOptions(params)
      );

    if (result.success) {
      return {
        skipped: false,
        success: true,
        result,
        rawError: null,
        errorInfo: null,
      };
    }

    return {
      skipped: false,
      success: false,
      result,
      rawError: result.error,
      errorInfo: getErrorDisplayInfo(result.error || '', { includeDetails: true }),
    };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error || '');
    return {
      skipped: false,
      success: false,
      rawError,
      errorInfo: getErrorDisplayInfo(error as Error | string, { includeDetails: true }),
    };
  }
}
