/** 群聊参与者目录的稳定展示 DTO；内部 actor key 不进入展示边界。 */

export interface GroupUserParticipant {
  userProfileId: string;
  displayName: string;
}

export interface GroupAssistantParticipant {
  assistantId: string;
  displayName: string;
  /** 仅用户 UI 使用；模型与 AI mention 解析继续使用公开 displayName。 */
  nickname?: string | null;
  avatar: string | null;
}

export interface GroupParticipantDirectory {
  currentUser: GroupUserParticipant;
  assistants: GroupAssistantParticipant[];
}
