/** 分享是发送时的正文和图片快照；原帖互动与可见范围仍由 Moments 持有。 */
export interface MomentShareSnapshot {
  schemaVersion: 1;
  momentId: string;
  author: { actorType: 'user' | 'ai'; actorId: string; name: string; displayName: string; avatar: { mediaAssetId: string } | null };
  content: string;
  locationLabel: string | null;
  createdAt: string;
  /** 旧的持久化分享没有此字段；新分享保存发送时的最后编辑时间。 */
  editedAt?: string | null;
  images: { mediaAssetId: string; analysisText: string | null }[];
}
