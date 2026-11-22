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
  writeChatTextDraft,
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

type AttachmentDraftSource = {
  type: ChatAttachmentType;
  source: ChatAttachmentSource;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
} & ({ originalUri: string; text?: never } | { text: string; originalUri?: never });

function buildInitialDraft(params: AttachmentDraftSource, id: string): AttachmentDraftItem {
  return {
    id,
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

const MAX_CHAT_IMAGE_SELECTION = 9;

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

  const prepareAttachments = useCallback(async (items: AttachmentDraftSource[], append = false) => {
    for (const params of items) {
      if (params.type === 'file') {
        assertChatAttachmentFileSupported({
          fileName: params.fileName,
        });
      }
    }
    if (!append) {
      operationIdRef.current += 1;
      draftRef.current.forEach(releaseDraft);
    }
    const operationId = operationIdRef.current;
    const drafts = items.map((source) => ({
      source,
      initialDraft: buildInitialDraft(source, createAttachmentDraftId(source.type === 'image' ? 'img' : 'file')),
    }));
    const initialDrafts = drafts.map(({ initialDraft }) => initialDraft);
    draftRef.current = append ? [...draftRef.current, ...initialDrafts] : initialDrafts;
    setDraftAttachments(draftRef.current);

    const results = await Promise.allSettled(drafts.map(async ({ source, initialDraft }) => {
      let persistedUri: string | null = null;

      try {
        setDraftIfLatest(operationId, {
          ...initialDraft,
          status: 'persisting',
        });

        const localUri = source.originalUri === undefined
          ? await writeChatTextDraft(initialDraft.id, source.text)
          : await persistDeviceMedia({
            sourceUri: source.originalUri,
            category: source.type === 'image' ? PERSISTENT_MEDIA_CATEGORY.chatImage : PERSISTENT_MEDIA_CATEGORY.chatFile,
            entityId: initialDraft.id,
            originalFileName: source.fileName,
            mimeType: source.mimeType,
          });
        persistedUri = localUri;
        draftLeases.current.set(localUri, ownChatAttachmentDraftFile(localUri));
        if (operationIdRef.current !== operationId || !draftRef.current.some((draft) => draft.id === initialDraft.id)) {
          releaseDraft({ ...initialDraft, localUri });
          return;
        }

        if (source.type === 'image') {
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
          fileName: source.fileName,
          mimeType: source.mimeType,
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

        if (source.type === 'file') {
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

  const selectDocumentAttachment = useCallback(async () => {
    const document = await pickChatDocumentFromDevice();
    if (!document) {
      return false;
    }

    await prepareAttachments([{
      type: document.type,
      source: document.source,
      originalUri: document.uri,
      fileName: document.fileName,
      mimeType: document.mimeType,
      fileSize: document.fileSize,
    }]);
    return true;
  }, [prepareAttachments]);

  const attachPastedText = useCallback((text: string) => prepareAttachments([{
    type: 'file',
    source: 'clipboard',
    fileName: '粘贴文本.txt',
    mimeType: 'text/plain',
    text,
  }], true), [prepareAttachments]);

  const readyAttachments = useMemo(() => {
    return draftAttachments.map(buildReadyAttachment).filter((attachment): attachment is ChatAttachment => attachment !== null);
  }, [draftAttachments]);

  /** 调用方在气泡接管或群聊提交成功时消费草稿；发送期间独立持有源文件。 */
  const withAttachmentSubmission = useCallback(async <T,>(
    submit: (attachments: ChatAttachment[], consumeDraft: () => void) => Promise<T>,
  ): Promise<T> => {
    const draft = draftRef.current;
    const attachments = draft.map(buildReadyAttachment).filter((attachment): attachment is ChatAttachment => attachment !== null);
    const releaseSubmission = retainChatAttachmentDraftFiles(attachments);
    const consumeDraft = () => {
      // 只消费本次提交捕获的草稿，发送期间新粘贴或新选择的附件继续保留。
      const consumedIds = new Set(attachments.map(({ id }) => id));
      const remaining = draftRef.current.filter((item) => !consumedIds.has(item.id));
      if (remaining.length === draftRef.current.length) return;
      draftRef.current.filter((item) => consumedIds.has(item.id)).forEach(releaseDraft);
      draftRef.current = remaining;
      setDraftAttachments(remaining);
    };
    try {
      return await submit(attachments, consumeDraft);
    } finally {
      releaseSubmission();
    }
  }, [releaseDraft]);

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
    attachPastedText,
    clearAttachment,
    removeAttachment,
  };
}

export default useAttachmentDraft;
