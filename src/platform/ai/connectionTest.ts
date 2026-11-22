/**
 * @fileoverview AI 连接测试
 *
 * 将连接可用性测试从客户端主文件中拆出，
 * 并统一通过客户端工厂创建实例，避免此文件直接耦合具体客户端类。
 *
 * @module platform/ai/connectionTest
 */

import { createAIClient } from './OpenAIClient';
import type { ConnectionTestResult, ConnectionTestOptions } from './types';

function createTestClient(
  baseURL: string,
  apiKey: string,
  model: string,
  options: ConnectionTestOptions
) {
  return createAIClient({
    baseURL,
    apiKey,
    model: model || 'test-model',
    temperature: options.skipParams ? null : options.temperature,
    maxTokens: options.skipParams ? null : options.maxTokens,
    topP: options.skipParams ? null : options.topP,
    disableThinking: options.disableThinking,
    reasoningEffort: options.reasoningEffort,
  });
}

/**
 * 测试 API 连接
 * @param baseURL - API 基础 URL
 * @param apiKey - API Key
 * @param model - 模型名称（可选，用于实际测试调用）
 * @param options - 可选参数
 * @returns 连接测试结果
 */
export async function testAPIConnection(
  baseURL: string,
  apiKey: string,
  model?: string,
  options: ConnectionTestOptions = {}
): Promise<ConnectionTestResult> {
  try {
    const client = createTestClient(baseURL, apiKey, model || '', options);

    return await client.testConnection();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}
