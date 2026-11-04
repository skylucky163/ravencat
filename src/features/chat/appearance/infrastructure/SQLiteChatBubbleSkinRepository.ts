import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import { parseBubbleDecorationConfig, parseBubbleSkinConfig, parseBubbleTextColor,
  type BubbleSkinRole, type BubbleSkinPreset, type BubbleSkinCollection, type ChatBubbleSkinRepository } from '../domain/ChatBubbleSkin';

export class SQLiteChatBubbleSkinRepository implements ChatBubbleSkinRepository {
  list(): Promise<BubbleSkinCollection> {
    return databaseCoordinator.read({ name: 'chat.bubbleSkin.list', feature: 'chat', priority: 'surface' }, async db => {
      const rows = await db.getAllAsync<{ id: string; role: BubbleSkinRole; name: string; revision: number; media_asset_id: string; width: number; height: number; config_json: string;
        decoration_id: string | null; slot: number; decoration_asset_id: string; decoration_width: number; decoration_height: number; decoration_config: string }>(
        `SELECT p.*, d.id AS decoration_id, d.slot, d.media_asset_id AS decoration_asset_id, d.width AS decoration_width,
          d.height AS decoration_height, d.config_json AS decoration_config FROM chat_bubble_presets p
         LEFT JOIN chat_bubble_preset_decorations d ON d.preset_id = p.id ORDER BY p.rowid, d.slot`);
      const presets = new Map<string, BubbleSkinPreset>();
      for (const row of rows) {
        if (!presets.has(row.id)) {
          const config = JSON.parse(row.config_json);
          presets.set(row.id, { id: row.id, role: row.role, name: row.name, revision: row.revision,
            mediaAssetId: row.media_asset_id, width: row.width, height: row.height,
            textColor: parseBubbleTextColor(config.textColor),
            config: parseBubbleSkinConfig(config, row.width, row.height), decorations: [] });
        }
        if (row.decoration_id !== null) presets.get(row.id)!.decorations.push({ id: row.decoration_id, slot: row.slot,
          mediaAssetId: row.decoration_asset_id, width: row.decoration_width, height: row.decoration_height,
          config: parseBubbleDecorationConfig(JSON.parse(row.decoration_config)) });
      }
      const selected: BubbleSkinCollection['selected'] = { user: null, ai: null };
      for (const row of await db.getAllAsync<{ role: BubbleSkinRole; preset_id: string }>('SELECT * FROM chat_bubble_selections')) selected[row.role] = row.preset_id;
      return { presets: [...presets.values()], selected };
    });
  }

  private async assets(tx: DatabaseTransactionExecutor, id: string): Promise<string[]> {
    const rows = await tx.getAllAsync<{ media_asset_id: string }>(
      `SELECT media_asset_id FROM chat_bubble_presets WHERE id = ?
       UNION SELECT media_asset_id FROM chat_bubble_preset_decorations WHERE preset_id = ?`, [id, id]);
    return rows.map(row => row.media_asset_id);
  }

  async save(tx: DatabaseTransactionExecutor, preset: BubbleSkinPreset): Promise<string[]> {
    const old = await this.assets(tx, preset.id);
    if (preset.revision === 0) {
      await tx.runAsync('INSERT INTO chat_bubble_presets (id, role, name, revision, media_asset_id, width, height, config_json) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
        [preset.id, preset.role, preset.name, preset.mediaAssetId, preset.width, preset.height, JSON.stringify({ ...preset.config, textColor: preset.textColor })]);
    } else {
      const result = await tx.runAsync(`UPDATE chat_bubble_presets SET name = ?, revision = revision + 1, media_asset_id = ?,
        width = ?, height = ?, config_json = json_set(?, '$.textColor', json_extract(config_json, '$.textColor')) WHERE id = ? AND role = ? AND revision = ?`,
      [preset.name, preset.mediaAssetId, preset.width, preset.height, JSON.stringify(preset.config), preset.id, preset.role, preset.revision]);
      if (result.changes !== 1) throw new Error('这个组合已被修改或删除，请重新打开编辑器');
    }
    await tx.runAsync('DELETE FROM chat_bubble_preset_decorations WHERE preset_id = ?', [preset.id]);
    for (const decoration of preset.decorations) await tx.runAsync(
      'INSERT INTO chat_bubble_preset_decorations (id, preset_id, slot, media_asset_id, width, height, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [decoration.id, preset.id, decoration.slot, decoration.mediaAssetId, decoration.width, decoration.height, JSON.stringify(decoration.config)]);
    await tx.runAsync('INSERT INTO chat_bubble_selections (role, preset_id) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET preset_id = excluded.preset_id', [preset.role, preset.id]);
    return old;
  }

  setTextColor(presetId: string, color: string): Promise<void> {
    // 字色由两个入口即时写同一字段；结构草稿保存保留最新字色，也不使结构 revision 失效。
    return databaseCoordinator.transaction({ name: 'chat.bubbleSkin.textColor', feature: 'chat', priority: 'interactive' }, async tx => {
      const result = await tx.runAsync("UPDATE chat_bubble_presets SET config_json = json_set(config_json, '$.textColor', ?) WHERE id = ?", [color, presetId]);
      if (result.changes !== 1) throw new Error('这个气泡组合已不存在');
    });
  }

  select(role: BubbleSkinRole, presetId: string | null): Promise<void> {
    return databaseCoordinator.transaction({ name: 'chat.bubbleSkin.select', feature: 'chat', priority: 'interactive' }, async tx => {
      if (presetId === null) await tx.runAsync('DELETE FROM chat_bubble_selections WHERE role = ?', [role]);
      else await tx.runAsync('INSERT INTO chat_bubble_selections (role, preset_id) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET preset_id = excluded.preset_id', [role, presetId]);
    });
  }

  remove(presetId: string): Promise<string[]> {
    return databaseCoordinator.transaction({ name: 'chat.bubbleSkin.remove', feature: 'chat', priority: 'interactive' }, async tx => {
      const old = await this.assets(tx, presetId);
      await tx.runAsync('DELETE FROM chat_bubble_presets WHERE id = ?', [presetId]);
      return old;
    });
  }
}
