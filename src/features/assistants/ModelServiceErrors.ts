/** SQLite 异常只在服务命令边界归类；界面与自动保存日志只接收脱敏后的错误。 */
import { CoordinatedDatabaseError } from '@platform/persistence';

type FailureKind = 'duplicate' | 'foreign_key' | 'busy' | 'locked' | 'connection' | 'schema' | 'constraint' | 'unknown';
const messages: Record<FailureKind, string> = {
  duplicate: '已有相同连接，请选择已有服务，或修改地址或凭据。',
  foreign_key: '关联配置写入失败，本次操作已回滚，请重新打开页面后重试。',
  busy: '数据库正忙，本次操作未保存，请稍后重试。',
  locked: '数据库被锁定，本次操作未保存，请稍后重试。',
  connection: '数据库暂时不可用，本次操作未保存，请重新打开应用后重试。',
  schema: '数据库结构尚未就绪，本次操作未保存，请重新打开应用；若仍失败请保留诊断记录。',
  constraint: '配置未满足数据库约束，本次操作已回滚，请保留诊断记录。',
  unknown: '本次操作未能完成，请重试；若仍失败请保留诊断记录。',
};
export class ModelServiceOperationError extends Error {
  constructor(readonly kind: FailureKind) { super(messages[kind]); this.name = 'ModelServiceOperationError'; }
}
export function describeModelServiceFailure(error: unknown): ModelServiceOperationError {
  const source = error instanceof CoordinatedDatabaseError ? error.cause : error;
  if (source instanceof ModelServiceOperationError) return source;
  const message = source instanceof Error ? source.message.toLowerCase() : String(source).toLowerCase();
  let kind: FailureKind = 'unknown';
  if (message.includes('unique constraint') && message.includes('model_service_configs.') && !message.includes('model_service_configs.ordinal')) kind = 'duplicate';
  else if (message.includes('foreign key constraint')) kind = 'foreign_key';
  else if (message.includes('sqlite_busy') || message.includes('database is busy')) kind = 'busy';
  else if (message.includes('sqlite_locked') || message.includes('database is locked') || message.includes('database table is locked')) kind = 'locked';
  else if (message.includes('no such table') || message.includes('no such column') || message.includes('has no column') || message.includes('migration')) kind = 'schema';
  else if (message.includes('closed') || message.includes('cannot open') || message.includes('unable to open')) kind = 'connection';
  else if (message.includes('constraint')) kind = 'constraint';
  return new ModelServiceOperationError(kind);
}
export function reportModelServiceFailure(operation: 'create' | 'update' | 'delete', phase: 'write' | 'refresh', serviceId: string | null, error: unknown): ModelServiceOperationError {
  const failure = describeModelServiceFailure(error);
  const source = error instanceof CoordinatedDatabaseError ? error.cause : error;
  const sqliteCode = source instanceof Error && 'errcode' in source && typeof source.errcode === 'number' ? source.errcode : undefined;
  // 不输出原始异常或 SQL 参数；某些原生错误会包含完整绑定值。
  console.warn('[服务配置]', { operation, phase, serviceId, kind: failure.kind, sqliteCode });
  return failure;
}
export function modelServiceFailureMessage(error: unknown): string {
  return error instanceof ModelServiceOperationError ? error.message : messages.unknown;
}
