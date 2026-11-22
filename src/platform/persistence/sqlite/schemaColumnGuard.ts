/** 加列迁移的可重入守卫：列已存在时跳过，避免重复执行把升级永久卡死。 */
export interface ColumnGuardExecutor {
  execAsync(source: string): Promise<unknown>;
  getAllAsync<T>(source: string): Promise<T[]>;
}

/**
 * 只在列缺失时执行 `ALTER TABLE ... ADD COLUMN`。
 * 列已存在说明它由更早的一次迁移或当前 schema 写入；重复执行必须是无操作。
 */
export async function addColumnIfMissing(
  db: ColumnGuardExecutor,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.some((entry) => entry.name === column)) return;
  await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}
