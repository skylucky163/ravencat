/** 朋友圈 Domain/Application 层的结构化失败原因。 */

export type MomentDomainErrorCode =
  | 'empty_content'
  | 'empty_edit'
  | 'edit_conflict'
  | 'empty_audience'
  | 'malformed_audience_agent_id'
  | 'unknown_audience_agent_id'
  | 'moment_not_visible'
  | 'moment_not_found'
  | 'comment_not_found'
  | 'comment_moment_mismatch'
  | 'not_moment_owner'
  | 'not_comment_owner'
  | 'invalid_media'
  | 'too_many_media'
  | 'media_not_found'
  | 'invalid_analysis_text'
  | 'invalid_location_label'
  | 'invalid_image_analysis_model';

/**
 * Moments 业务校验失败。
 *
 * 这些是"调用方给了不合法业务输入"的结构化结果，不是数据库错误：
 * `moment_not_visible` 同时覆盖"不存在"与"对该 viewer 不可见"，
 * 避免 AI consumer 通过错误差异探测不可见 Moment 的存在性。
 */
export class MomentDomainError extends Error {
  constructor(
    public readonly code: MomentDomainErrorCode,
    message: string,
    public readonly detail = ''
  ) {
    super(message);
    this.name = 'MomentDomainError';
  }
}
