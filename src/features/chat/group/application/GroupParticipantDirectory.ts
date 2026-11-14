/** 从群成员关系与当前资料构建群聊自己的参与者目录。 */

import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import type { GroupChatDetails } from '../domain/GroupChat';
import type {
  GroupAssistantParticipant,
  GroupParticipantDirectory,
} from '../domain/GroupParticipantDirectory';

export async function getGroupParticipantDirectory(
  details: GroupChatDetails,
): Promise<GroupParticipantDirectory> {
  const runtime = getChatGroupRuntimeDependencies();
  const [currentUser, assistantProfiles] = await Promise.all([
    runtime.currentUserDirectory.getCurrent(),
    Promise.all(
      details.members
        .filter((member) => member.enabled)
        .map((member) => runtime.assistantDirectory.getById(member.aiAssistantId)),
    ),
  ]);
  const assistants = assistantProfiles
    .filter((profile): profile is NonNullable<typeof profile> => profile !== null)
    .map<GroupAssistantParticipant>((profile) => ({
      assistantId: profile.id,
      displayName: profile.name,
      nickname: profile.nickname,
      avatar: profile.avatar,
    }));

  return {
    currentUser: {
      userProfileId: currentUser.id,
      displayName: currentUser.name,
    },
    assistants,
  };
}
