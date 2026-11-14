import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { AgentToolExecutionContext } from '@shared/aiTools';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type { AIDownloadedImageRepository } from '../domain/AIDownloadedImageRepository';
import type { AIGeneratedImageRepository } from '../domain/AIGeneratedImageRepository';

export interface AIImageRuntimeDependencies {
  downloads: AIDownloadedImageRepository;
  generated: AIGeneratedImageRepository;
  assertCurrent(transaction: DatabaseTransactionExecutor, context: AgentToolExecutionContext): Promise<void>;
  resolveAvatar(target: 'user_avatar' | 'self_avatar' | 'assistant_avatar', assistantId: string, selector?: string): Promise<
    | { status: 'found'; mediaAssetId?: string; imageUri?: string; label: string }
    | { status: 'ambiguous'; candidates: { id: string; name: string }[] }
    | { status: 'not_found'; message: string }
  >;
  view(input: { assistantId: string; imageUri: string; mimeType: string; isAnimated: boolean; contextText: string; signal: AbortSignal }): Promise<{
    parts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
    route: string; ocrSucceeded: boolean | null;
  }>;
}

export const aiImageRuntime = createRuntimeSlot<AIImageRuntimeDependencies>('AIImageTools');
export const configureAIImageRuntime = (dependencies: AIImageRuntimeDependencies) => aiImageRuntime.configure(dependencies);
