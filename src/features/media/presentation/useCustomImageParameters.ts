import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomImageParameterField, CustomImageParameters } from '@platform/ai/imageGenerationConfig';
import type { ImageParameterCheckResult } from '@platform/ai/ImageGenerationParameterCheck';
import { checkSelectedImageParameter } from '../application/CheckImageGenerationParameter';
import type { CustomImageConnection } from '../application/ImageGenerationModels';

export interface CustomImageParameterRow {
  value: string;
  testedValue?: string;
  result?: ImageParameterCheckResult;
  supportedValues?: readonly string[];
}
type Rows = Partial<Record<CustomImageParameterField, CustomImageParameterRow>>;

export function useCustomImageParameters() {
  const [rows, setRows] = useState<Rows>({});
  const [checking, setChecking] = useState<CustomImageParameterField | null>(null);
  const currentRows = useRef(rows);
  const connection = useRef<CustomImageConnection | null>(null);
  const pending = useRef<{ field: CustomImageParameterField; controller: AbortController } | null>(null);
  const update = useCallback((next: Rows) => {
    currentRows.current = next;
    setRows(next);
  }, []);
  const cancel = useCallback(() => pending.current?.controller.abort(), []);
  useEffect(() => () => { cancel(); pending.current = null; }, [cancel]);
  const activate = useCallback((next: CustomImageConnection | null) => {
    if (connection.current === next || next && connection.current?.equals(next)) return;
    connection.current = next;
    cancel();
    update({});
  }, [cancel, update]);

  function change(field: CustomImageParameterField, value: string) {
    const previous = currentRows.current[field];
    if ((previous?.value ?? '') === value || previous?.result?.status === 'rejected' && previous.result.scope === 'field') return;
    if (pending.current?.field === field) cancel();
    update({ ...currentRows.current, [field]: { value, supportedValues: previous?.supportedValues } });
  }

  async function check(field: CustomImageParameterField) {
    const target = connection.current;
    const row = currentRows.current[field];
    if (pending.current || target === null || !row?.value) return;
    const controller = new AbortController();
    pending.current = { field, controller };
    setChecking(field);
    try {
      let result: ImageParameterCheckResult | null;
      try { result = await checkSelectedImageParameter(target, { field, value: row.value }, controller.signal); }
      catch {
        result = { status: 'uncertain', reason: '读取模型配置或完成参数检测时出错。' };
      }
      if (controller.signal.aborted || result === null) return;
      const fieldRejected = result.status === 'rejected' && result.scope === 'field';
      update({ ...currentRows.current, [field]: {
        value: fieldRejected ? '' : row.value, testedValue: row.value, result,
        supportedValues: result.status === 'rejected' && result.supportedValues.length ? result.supportedValues : row.supportedValues,
      } });
    } finally {
      if (pending.current?.controller === controller) {
        pending.current = null;
        setChecking(null);
      }
    }
  }

  function getParameters(): CustomImageParameters {
    return Object.fromEntries(Object.entries(currentRows.current)
      .filter(([, row]) => row.value && row.result?.status !== 'rejected')
      .map(([field, row]) => [field, row.value]));
  }

  const activeField = pending.current?.controller.signal.aborted ? null : checking;
  return { rows, checking, activeField, activate, change, check, cancel, getParameters, isChecking: () => pending.current !== null };
}
