/** 管理聊天图片和文件附件的选择、持久化、解析与草稿状态。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ownChatAttachmentDraftFile, retainChatAttachmentDraftFiles } from './ChatAttachmentDraftFiles';

import {
  attachmentParser,
  assertChatAttachmentFileSupported,
} from '../../../messages/application/AttachmentParser';
import type {
  AttachmentDraftItem,
  ChatAttachment,
  ChatAttachmentType,
  ChatAttachmentSource,
} from '@features/chat/messages/domain';
import { createAttachmentDraftId } from '@features/chat/messages/domain';
import {
  PERSISTENT_MEDIA_CATEGORY,
  captureChatPhotoFromDevice,
  persistDeviceMedia,
  pickChatDocumentFromDevice,
  pickChatImagesFromDevice,
} from '@platform/device/DeviceMediaService';

function buildReadyAttachment(draft: AttachmentDraftItem): ChatAttachment | null {
  if (draft.status !== 'ready' || !draft.localUri) {
    return null;
  }

  return {
    id: draft.id,
    type: draft.type,
    source: draft.source,
    localUri: draft.localUri,
    fileName: draft.fileName,
    mimeType: draft.mimeType,
    fileSize: draft.fileSize,
    width: draft.width,
    height: draft.height,
    thumbnailUri: draft.thumbnailUri,
    parseStatus: draft.parseStatus,
    parsedText: draft.parsedText,
    parseError: draft.parseError,
    parserName: draft.parserName,
    previewText: draft.previewText,
  };
}

function buildInitialDraft(params: {
  id: string;
  type: ChatAttachmentType;
  source: ChatAttachmentSource;
  originalUri: string;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
}): AttachmentDraftItem {
  return {
    id: params.id,
    type: params.type,
    source: params.source,
    originalUri: params.originalUri,
    localUri: null,
    fileName: params.fileName,
    mimeType: params.mimeType ?? null,
    fileSize: params.fileSize ?? null,
    width: params.width ?? null,
    height: params.height ?? null,
    thumbnailUri: null,
    status: 'preparing',
    parseStatus: params.type === 'file' ? 'pending' : 'skipped',
    parsedText: null,
    parseError: null,
    parserName: null,
    previewText: null,
    errorMessage: null,
  };
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp'];
const MAX_CHAT_IMAGE_SELECTION = 9;

function isImageFile(fileName: string, mimeType?: string | null): boolean {
  if (mimeType?.startsWith('image/')) {
    return true;
  }
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXTENSIONS.includes(extension);
}

export function useAttachmentDraft() {
  const [draftAttachments, setDraftAttachments] = useState<AttachmentDraftItem[]>([]);
  const operationIdRef = useRef(0);
  const draftRef = useRef<AttachmentDraftItem[]>([]);
  const draftLeases = useRef(new Map<string, () => void>());

  const releaseDraft = useCallback((draft: AttachmentDraftItem | null) => {
    if (!draft?.localUri) return;
    draftLeases.current.get(draft.localUri)?.();
    draftLeases.current.delete(draft.localUri);
  }, []);

  const clearAttachment = useCallback(() => {
    operationIdRef.current += 1;
    draftRef.current.forEach(releaseDraft);
    draftRef.current = [];
    setDraftAttachments(draftRef.current);
  }, [releaseDraft]);

  useEffect(() => () => {
    operationIdRef.current += 1;
    draftRef.current.forEach(releaseDraft);
    draftRef.current = [];
  }, [releaseDraft]);

  const removeAttachment = useCallback((id: string) => {
    releaseDraft(draftRef.current.find((draft) => draft.id === id) ?? null);
    draftRef.current = draftRef.current.filter((draft) => draft.id !== id);
    setDraftAttachments(draftRef.current);
  }, [releaseDraft]);

  const setDraftIfLatest = useCallback((operationId: number, updater: AttachmentDraftItem) => {
    // 单张移除不取消同批其他图片；晚到的文件仍由原草稿负责释放。
    if (operationIdRef.current !== operationId || !draftRef.current.some((draft) => draft.id === updater.id)) {
      releaseDraft(updater);
      return;
    }
    draftRef.current = draftRef.current.map((draft) => draft.id === updater.id ? updater : draft);
    setDraftAttachments(draftRef.current);
  }, [releaseDraft]);

  const prepareAttachments = useCallback(async (items: {
    type: ChatAttachmentType;
    source: ChatAttachmentSource;
    originalUri: string;
    fileName: string;
    mimeType?: string | null;
    fileSize?: number | null;
    width?: number | null;
    height?: number | null;
  }[]) => {
    for (const params of items) {
      if (params.type === 'file') {
        assertChatAttachmentFileSupported({
          fileName: params.fileName,
        });
      }
    }
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    draftRef.current.forEach(releaseDraft);
    const initialDrafts = items.map((params) => buildInitialDraft({
      ...params,
      id: createAttachmentDraftId(params.type === 'image' ? 'img' : 'file'),
    }));
    draftRef.current = initialDrafts;
    setDraftAttachments(initialDrafts);

    const results = await Promise.allSettled(initialDrafts.map(async (initialDraft) => {
      const params = initialDraft;
      let persistedUri: string | null = null;

      try {
        setDraftIfLatest(operationId, {
          ...initialDraft,
          status: 'persisting',
        });

        const localUri = await persistDeviceMedia({
          sourceUri: params.originalUri,
          category:
            params.type === 'image'
              ? PERSISTENT_MEDIA_CATEGORY.chatImage
              : PERSISTENT_MEDIA_CATEGORY.chatFile,
          entityId: initialDraft.id,
          originalFileName: params.fileName,
          mimeType: params.mimeType,
        });
        persistedUri = localUri;
        draftLeases.current.set(localUri, ownChatAttachmentDraftFile(localUri));
        if (operationIdRef.current !== operationId || !draftRef.current.some((draft) => draft.id === initialDraft.id)) {
          releaseDraft({ ...initialDraft, localUri });
          return;
        }

        if (params.type === 'image') {
          setDraftIfLatest(operationId, {
            ...initialDraft,
            localUri,
            thumbnailUri: localUri,
            status: 'ready',
            parseStatus: 'skipped',
          });
          return;
        }

        setDraftIfLatest(operationId, {
          ...initialDraft,
          localUri,
          status: 'parsing',
          parseStatus: 'parsing',
        });

        const parseResult = await attachmentParser.parseFile({
          localUri,
          fileName: params.fileName,
          mimeType: params.mimeType,
        });

        if (parseResult.parseStatus !== 'success') {
          throw new Error(
            parseResult.parseError
              ? `文件解析失败，无法发送：${parseResult.parseError}`
              : '文件无法解析，无法发送'
          );
        }

        setDraftIfLatest(operationId, {
          ...initialDraft,
          localUri,
          status: 'ready',
          parseStatus: parseResult.parseStatus,
          parsedText: parseResult.parsedText,
          parseError: parseResult.parseError,
          parserName: parseResult.parserName,
          previewText: parseResult.previewText,
        });
      } catch (error) {
        releaseDraft({ ...initialDraft, localUri: persistedUri });
        if (operationIdRef.current !== operationId || !draftRef.current.some((draft) => draft.id === initialDraft.id)) {
          return;
        }
        const message = error instanceof Error ? error.message : '附件处理失败';

        if (params.type === 'file') {
          removeAttachment(initialDraft.id);
          throw error;
        }

        setDraftIfLatest(operationId, {
          ...initialDraft,
          status: 'failed',
          parseStatus: 'skipped',
          errorMessage: message,
          parseError: null,
        });
        throw error;
      }
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }, [releaseDraft, removeAttachment, setDraftIfLatest]);

  const selectImageAttachment = useCallback(async () => {
    const images = await pickChatImagesFromDevice(MAX_CHAT_IMAGE_SELECTION);
    if (!images) {
      return false;
    }

    await prepareAttachments(images.map((image) => ({
      type: 'image',
      source: image.source,
      originalUri: image.uri,
      fileName: image.fileName,
      mimeType: image.mimeType,
      fileSize: image.fileSize,
      width: image.width,
      height: image.height,
    })));
    return true;
  }, [prepareAttachments]);

  const capturePhotoAttachment = useCallback(async () => {
    const photo = await captureChatPhotoFromDevice();
    if (!photo) {
      return false;
    }

    await prepareAttachments([{
      type: 'image',
      source: photo.source,
      originalUri: photo.uri,
      fileName: photo.fileName,
      mimeType: photo.mimeType,
      fileSize: photo.fileSize,
      width: photo.width,
      height: photo.height,
    }]);
    return true;
  }, [prepareAttachments]);

  // 常见图片文件后缀（用于文件选择器选择的图片识别）
  const selectDocumentAttachment = useCallback(async () => {
    const document = await pickChatDocumentFromDevice();
    if (!document) {
      return false;
    }

    // 检查是否是图片文件，如果是则按图片类型处理
    const shouldTreatAsImage = isImageFile(document.fileName, document.mimeType);

    if (shouldTreatAsImage) {
      await prepareAttachments([{
        type: 'image',
        source: document.source,
        originalUri: document.uri,
        fileName: document.fileName,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
      }]);
    } else {
      await prepareAttachments([{
        type: 'file',
        source: document.source,
        originalUri: document.uri,
        fileName: document.fileName,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
      }]);
    }
    return true;
  }, [prepareAttachments]);

  const readyAttachments = useMemo(() => {
    return draftAttachments.map(buildReadyAttachment).filter((attachment): attachment is ChatAttachment => attachment !== null);
  }, [draftAttachments]);

  /** 调用方在气泡接管或群聊提交成功时消费草稿；发送期间独立持有源文件。 */
  const withAttachmentSubmission = useCallback(async <T,>(
    submit: (attachments: ChatAttachment[], consumeDraft: () => void) => Promise<T>,
  ): Promise<T> => {
    const draft = draftRef.current;
    const operationId = operationIdRef.current;
    const attachments = draft.map(buildReadyAttachment).filter((attachment): attachment is ChatAttachment => attachment !== null);
    const releaseSubmission = retainChatAttachmentDraftFiles(attachments);
    const consumeDraft = () => {
      // 发送途中移除单张仍属于同批；重新选择的下一批不能被旧提交清空。
      if (operationIdRef.current === operationId) clearAttachment();
    };
    try {
      return await submit(attachments, consumeDraft);
    } finally {
      releaseSubmission();
    }
  }, [clearAttachment]);

  return {
    draftAttachments,
    readyAttachments,
    withAttachmentSubmission,
    hasAttachment: draftAttachments.length > 0,
    hasFailedAttachment: draftAttachments.some((draft) => draft.status === 'failed'),
    isPreparingAttachment: draftAttachments.some((draft) =>
      draft.status === 'preparing' || draft.status === 'persisting' || draft.status === 'parsing'),
    selectImageAttachment,
    capturePhotoAttachment,
    selectDocumentAttachment,
    clearAttachment,
    removeAttachment,
  };
}

export default useAttachmentDraft;
