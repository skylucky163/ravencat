/** 已提交 Moment 图片的 one-shot 分析、手动重试与用户描述编辑。 */
import { SELF_USER_PROFILE_ID } from '@features/profile';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { MomentDomainError } from '../domain/MomentErrors';
import {
  MomentImageAnalysisError,
  type MomentImageAnalysisErrorCode,
} from '../domain/MomentImageAnalysis';
import type { MomentMedia } from '../domain/MomentRepository';
import { getMomentMediaRuntime } from './MomentMediaRuntime';
import { getMomentSettings, resolveMomentImageAnalysisModel } from './MomentSettings';

export const MAX_MOMENT_MEDIA_ANALYSIS_LENGTH = 4000;

export type MomentMediaAnalysisAttemptResult =
  | { success: true; mediaId: string }
  | { success: false; mediaId: string; errorCode: MomentImageAnalysisErrorCode; errorMessage: string };

type MomentMediaAnalysisListener = (mediaId: string) => void;
const listeners = new Set<MomentMediaAnalysisListener>();

export function subscribeMomentMediaAnalysisUpdated(
  listener: MomentMediaAnalysisListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitUpdated(mediaId: string): void {
  listeners.forEach((listener) => listener(mediaId));
}

function normalizeAnalysisText(text: string): string {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) throw new MomentImageAnalysisError('empty_analysis', '图片理解模型返回了空描述');
  if (normalized.length > MAX_MOMENT_MEDIA_ANALYSIS_LENGTH) {
    return normalized.slice(0, MAX_MOMENT_MEDIA_ANALYSIS_LENGTH);
  }
  return normalized;
}

/**
 * 失败结果与广播的统一收口：只有 CAS 真的写入了失败事实才广播 state update。
 *
 * - 初始尝试的 CAS 已经 stale（图片已不在 pending，或用户已经编辑过描述）时，这次尝试
 *   没有改变任何事实，按 stale_analysis_attempt 收口，且不得广播。
 * - 手动 retry 对已有成功描述因保护条件未写入时，仍返回这次尝试真实的失败错误码，但
 *   同样不得伪造 state update；旧的成功 snapshot 继续有效。
 */
function settleAnalysisFailure(
  mediaId: string,
  errorCode: MomentImageAnalysisErrorCode,
  errorMessage: string,
  saved: boolean,
  initial: boolean
): MomentMediaAnalysisAttemptResult {
  if (!saved && initial) {
    return { success: false, mediaId, errorCode: 'stale_analysis_attempt', errorMessage: '图片描述已更新，本次识别未覆盖当前描述。' };
  }
  if (saved) emitUpdated(mediaId);
  return { success: false, mediaId, errorCode, errorMessage };
}

async function analyze(
  media: MomentMedia,
  options: { initial: boolean; signal?: AbortSignal }
): Promise<MomentMediaAnalysisAttemptResult> {
  const runtime = getMomentMediaRuntime();
  const settings = await getMomentSettings();
  if (!settings.imageAnalysisModelConfigId) {
    const at = runtime.now();
    const errorMessage = '尚未配置图片理解模型，请在时刻设置中选择模型。';
    const saved = await runtime.repository.saveAnalysisFailure({
      mediaId: media.id,
      expectedRevision: media.analysisRevision,
      expectedPending: options.initial,
      errorCode: 'model_not_configured',
      errorMessage,
      analyzedAt: at,
    });
    return settleAnalysisFailure(media.id, 'model_not_configured', errorMessage, saved, options.initial);
  }
  const model = await resolveMomentImageAnalysisModel(settings);
  if (!model) {
    const at = runtime.now();
    const errorMessage = '所选图片理解模型不可用，请在时刻设置中检查模型配置。';
    const saved = await runtime.repository.saveAnalysisFailure({
      mediaId: media.id,
      expectedRevision: media.analysisRevision,
      expectedPending: options.initial,
      errorCode: 'model_unavailable',
      errorMessage,
      analyzedAt: at,
    });
    return settleAnalysisFailure(media.id, 'model_unavailable', errorMessage, saved, options.initial);
  }

  let text: string;
  try {
    throwIfAbortSignalAborted(options.signal);
    text = normalizeAnalysisText(await runtime.executeImageAnalysis({
      mediaAssetId: media.mediaAssetId,
      model,
      signal: options.signal,
    }));
  } catch (error) {
    throwIfAbortSignalAborted(options.signal);
    // 只有模型调用与输出校验可以转换为识别失败；持久化异常必须继续上抛。
    const failure = error instanceof MomentImageAnalysisError
      ? error
      : new MomentImageAnalysisError('model_request_failed', '图片理解处理失败，请稍后重试。');
    const saved = await runtime.repository.saveAnalysisFailure({
      mediaId: media.id,
      expectedRevision: media.analysisRevision,
      expectedPending: options.initial,
      errorCode: failure.code,
      errorMessage: failure.message,
      analyzedAt: runtime.now(),
    });
    return settleAnalysisFailure(media.id, failure.code, failure.message, saved, options.initial);
  }

  const saved = await runtime.repository.saveModelAnalysis({
    mediaId: media.id,
    expectedRevision: media.analysisRevision,
    expectedPending: options.initial,
    text,
    modelConfigId: model.id,
    analyzedAt: runtime.now(),
  });
  if (saved) emitUpdated(media.id);
  return saved
    ? { success: true, mediaId: media.id }
    : { success: false, mediaId: media.id, errorCode: 'stale_analysis_attempt', errorMessage: '图片描述已更新，本次识别未覆盖当前描述。' };
}

/** 仅处理这次刚提交、仍为 pending 的图片；顺序执行，单图失败不阻断下一张。 */
export async function analyzeNewMomentMediaOneShot(momentId: string): Promise<void> {
  const runtime = getMomentMediaRuntime();
  const media = await runtime.repository.listMedia(momentId);
  for (const item of media) {
    if (item.analysisStatus !== 'pending') continue;
    try {
      await analyze(item, { initial: true });
    } catch (error) {
      console.warn('[Moments] 新图片 one-shot 分析未完成：', { mediaId: item.id, error });
    }
  }
}

async function requireOwnedMedia(mediaId: string): Promise<MomentMedia> {
  const runtime = getMomentMediaRuntime();
  const media = await runtime.repository.getMedia(mediaId);
  if (!media) throw new MomentDomainError('media_not_found', '时刻图片不存在', mediaId);
  const moment = await runtime.repository.getMomentForUser(media.momentId);
  if (!moment) throw new MomentDomainError('moment_not_found', '时刻不存在', media.momentId);
  if (moment.authorType !== 'user' || moment.authorId !== SELF_USER_PROFILE_ID) {
    throw new MomentDomainError('not_moment_owner', '只能管理自己发布的时刻图片', media.momentId);
  }
  return media;
}

export async function reanalyzeMomentMedia(
  mediaId: string,
  signal?: AbortSignal
): Promise<MomentMediaAnalysisAttemptResult> {
  const media = await requireOwnedMedia(mediaId);
  return analyze(media, { initial: false, signal });
}

export async function editMomentMediaAnalysis(mediaId: string, text: string): Promise<MomentMedia> {
  await requireOwnedMedia(mediaId);
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized || normalized.length > MAX_MOMENT_MEDIA_ANALYSIS_LENGTH) {
    throw new MomentDomainError(
      'invalid_analysis_text',
      `图片描述长度必须为 1-${MAX_MOMENT_MEDIA_ANALYSIS_LENGTH}`
    );
  }
  const updated = (await getMomentMediaRuntime().repository.editMediaAnalysis({
    mediaId,
    text: normalized,
    analyzedAt: getMomentMediaRuntime().now(),
  }))!;
  emitUpdated(mediaId);
  return updated;
}
