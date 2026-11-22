// 连接测试与错误分类；工具权限由独立开关拥有。

import { type AppDialogButton, type AppDialogTone } from '@shared/ui';
import { useState, useCallback } from 'react';
import {
  detectConnectionParamError,
  getAIConnectionErrorInfo,
} from '../../../application/AIModelService';
import type { ParamErrorInfo, ErrorDisplayInfo } from '../../../application/modelTypes';
import { runConnectionTestByConfig } from '../sharedModelConfig';
import type { ConnectionParams } from './modelSettingsHelpers';

interface UseConnectionTestProps {
  apiBaseUrl: string;
  apiKey: string;
  selectedModel: string;
  getConnectionParams: () => ConnectionParams;
  onShowAlert?: (title: string, message: string, buttons?: AppDialogButton[], tone?: AppDialogTone) => void;
}

interface UseConnectionTestReturn {
  isTesting: boolean;
  testResult: 'success' | 'error' | 'param_error' | null;
  testErrorInfo: ParamErrorInfo | { message: string; type?: string } | null;
  resetTestState: () => void;
  handleTestConnection: () => Promise<void>;
}

export default function useConnectionTest({
  apiBaseUrl,
  apiKey,
  selectedModel,
  getConnectionParams,
  onShowAlert,
}: UseConnectionTestProps): UseConnectionTestReturn {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | 'param_error' | null>(null);
  const [testErrorInfo, setTestErrorInfo] = useState<ParamErrorInfo | { message: string; type?: string } | null>(null);

  const resetTestState = useCallback(() => {
    setTestResult(null);
    setTestErrorInfo(null);
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!apiBaseUrl || !apiKey || !selectedModel) {
      return;
    }

    setIsTesting(true);
    resetTestState();

    try {
      const connectionParams = getConnectionParams();
      const result = await runConnectionTestByConfig({
        apiBaseUrl,
        apiKey,
        selectedModel,
        requestOptions: connectionParams,
      });

      if (result.success) {
        onShowAlert?.(
          '连接成功',
          `模型 "${selectedModel}" 连接正常。`,
          [{ text: '知道了', style: 'default' }], 'success'
        );

        setTestResult('success');
        return;
      }

      const paramError = detectConnectionParamError(result.rawError as string);

      if (paramError.isParamError) {
        setTestResult('param_error');
        setTestErrorInfo({ ...paramError, message: result.errorInfo!.message });

        if (onShowAlert) {
          const paramDisplayName = paramError.paramName === 'temperature'
            ? 'Temperature'
            : paramError.paramName === 'topP'
              ? 'Top P'
              : paramError.paramName === 'reasoningEffort'
                ? '思考强度或思维链开关'
                : paramError.paramName === 'maxTokens' ? 'Max Tokens' : '模型参数';
          const suggestion = paramError.allowedValue
            ? `请将 ${paramDisplayName} 设置为 ${paramError.allowedValue} 后再测试。`
            : `请调整 ${paramDisplayName} 后再测试。`;

          onShowAlert(
            '参数设置错误',
            `${result.errorInfo!.message}\n\n${suggestion}`,
            [{ text: '知道了', style: 'default' }], 'error'
          );
        }
      } else {
        setTestResult('error');
        setTestErrorInfo({
          message: (result.errorInfo as ErrorDisplayInfo | undefined)?.message || (result.rawError as string),
          type: (result.errorInfo as ErrorDisplayInfo | undefined)?.type || 'connection',
        });

        onShowAlert?.(
          (result.errorInfo as ErrorDisplayInfo | undefined)?.title || '连接失败',
          (result.errorInfo as ErrorDisplayInfo | undefined)?.message || (result.rawError as string) || '无法连接到模型，请检查 API Key 和 URL。',
          [{ text: '知道了', style: 'default' }], 'error'
        );
      }

      console.log('[ModelSettings] Test connection failed:', result.rawError);
    } catch (error) {
      const errorInfo = getAIConnectionErrorInfo(error as Error);

      setTestResult('error');
      setTestErrorInfo({ message: errorInfo.message, type: errorInfo.type || 'connection' });

      onShowAlert?.(
        errorInfo.title || '连接错误',
        errorInfo.message || '测试连接时发生错误。',
        [{ text: '知道了', style: 'default' }], 'error'
      );

      console.log('[ModelSettings] Test connection error:', errorInfo.message);
    } finally {
      setIsTesting(false);
    }
  }, [
    apiBaseUrl,
    apiKey,
    selectedModel,
    getConnectionParams,
    onShowAlert,
    resetTestState,
  ]);

  return {
    isTesting,
    testResult,
    testErrorInfo,
    resetTestState,
    handleTestConnection,
  };
}
