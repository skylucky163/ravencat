/** Chat Completions 的文本分类、可选协议诊断与原始思考回放。 */
import type { AIClientConfig, AIProtocolIssue, ChatStreamDelta, OpenAIAssistantPayload, OpenAIReasoningReplay } from './types';

type TextDelta = Extract<ChatStreamDelta, { type: 'reasoning_delta' | 'answer_delta' }>;
type ReasoningSource = 'native' | 'structured' | 'details' | 'tag';

export interface ReasoningCompletionContext {
  hasToolCalls: boolean;
  replayContract: 'native' | 'content' | 'details';
  thinkingDisabled?: boolean;
}

/** 只使用已确认的官方接口契约，不能把第三方模型别名当成官方协议。 */
export function reasoningReplayContract(baseURL: string): ReasoningCompletionContext['replayContract'] {
  const host = new URL(baseURL).hostname;
  if (host === 'api.deepseek.com') return 'native';
  if (host === 'api.mistral.ai') return 'content';
  // OpenRouter 的特殊块与未知中转站都不能在载荷损坏时假定 details 无关紧要。
  return 'details';
}

export function usesLeadingThinkTags(config: AIClientConfig): boolean {
  if (config.thinkTagMode !== undefined) return config.thinkTagMode === 'leading';
  const name = config.model.toLowerCase().split('/').pop()!;
  // 标签属于这些模型的已知输出约定；不从 Gemini／Claude 别名猜测标签协议。
  return /^(?:deepseek-(?:r1|reasoner)(?:-|$)|qwq(?:-|$)|qwen3(?:[.-]|$))/.test(name)
    && !/(?:instruct|coder|non-thinking)/.test(name);
}

/** 只接管首段；一旦开始正文，不再把正文或代码示例里的标签解释为控制标记。 */
class LeadingThinkDecoder {
  private state: 'prefix' | 'thinking' | 'answer';
  private pending = '';
  recognized = false;

  constructor(enabled: boolean) { this.state = enabled ? 'prefix' : 'answer'; }

  push(text: string, final = false): { text: string; reasoning: string } {
    this.pending += text;
    if (this.state === 'prefix') {
      const head = this.pending.trimStart();
      const whitespace = this.pending.slice(0, this.pending.length - head.length);
      const indentation = whitespace.slice(whitespace.lastIndexOf('\n') + 1);
      const indentedCode = indentation.includes('\t') || indentation.length >= 4;
      if (!indentedCode && !final && '<think>'.startsWith(head) && head.length < 7) {
        return { text: '', reasoning: '' };
      }
      if (!indentedCode && head.startsWith('<think>')) {
        this.recognized = true;
        this.state = 'thinking';
        this.pending = head.slice(7);
      } else {
        this.state = 'answer';
      }
    }
    if (this.state === 'answer') {
      const result = { text: this.pending, reasoning: '' };
      this.pending = '';
      return result;
    }
    const close = this.pending.indexOf('</think>');
    if (close >= 0) {
      const result = { reasoning: this.pending.slice(0, close), text: this.pending.slice(close + 8) };
      this.pending = '';
      this.state = 'answer';
      return result;
    }
    // 关闭标签可能横跨 delta；只扣留最长的标记前缀，其余思考可立即交给现有事件链。
    let held = 0;
    if (!final) {
      for (let length = 1; length < 8; length++) {
        if (this.pending.endsWith('</think>'.slice(0, length))) held = length;
      }
    }
    const result = { text: '', reasoning: this.pending.slice(0, this.pending.length - held) };
    this.pending = this.pending.slice(this.pending.length - held);
    return result;
  }
}

export interface AssistantTextResult {
  text: string;
  contentText: string;
  reasoningText: string;
  source: 'content' | 'reasoning' | 'empty';
  reasoningReplay?: OpenAIReasoningReplay;
}

export class OpenAIMessageDecoder {
  private tags: LeadingThinkDecoder;
  private contentText = '';
  private reasoningText = '';
  private nativeReasoning = '';
  private hasNativeReasoning = false;
  private source: ReasoningSource | undefined;
  private rawContent: (string | unknown[])[] = [];
  private structured = false;
  private details = new Map<string, Record<string, unknown>>();
  private detailTextLengths = new Map<string, number>();
  private anonymousDetail = 0;
  private issues: AIProtocolIssue[] = [];
  private frame = 0;
  private detailsUnsafe = false;
  private invalidDetailKeys = new Set<string>();
  private nativeReplayTrusted = true;

  get protocolIssues(): readonly AIProtocolIssue[] { return this.issues; }

  constructor(private readonly parseThinkTags: boolean) {
    this.tags = new LeadingThinkDecoder(parseThinkTags);
  }

  append(message: OpenAIAssistantPayload): TextDelta[] {
    this.frame++;
    const output: TextDelta[] = [];
    const native = message.reasoning_content ?? message.reasoning;
    if (native != null) {
      this.hasNativeReasoning = true;
      this.nativeReplayTrusted &&= typeof native === 'string';
      const text = extractTextFromNode(native);
      this.nativeReasoning += text;
      this.reason('native', text, output);
    }
    const detailText = this.appendDetails(message.reasoning_details);
    const content = message.content;
    if (typeof content === 'string' || Array.isArray(content)) this.rawContent.push(content);
    else if (isObject(content) && (content.type === 'thinking' || content.type === 'reasoning')) this.rawContent.push([content]);
    const blocks = Array.isArray(content) ? content : [content];
    const body: string[] = [];
    const thought: string[] = [];
    for (const block of blocks) {
      if (isObject(block) && (block.type === 'thinking' || block.type === 'reasoning')) {
        this.structured = true;
        // 只读明确的可读字段，signature／data 等即使是字符串也不能变成正文或思考。
        if (block.type === 'reasoning' && typeof block.text === 'string') thought.push(block.text);
        if (block.type === 'thinking' && typeof block.thinking === 'string') thought.push(block.thinking);
        if (block.type === 'thinking' && Array.isArray(block.thinking)) {
          for (const inner of block.thinking) {
            if (isObject(inner) && inner.type === 'text' && typeof inner.text === 'string') thought.push(inner.text);
          }
        }
      } else body.push(extractTextFromNode(block));
    }
    this.reason('structured', thought.join(''), output);
    this.reason('details', detailText, output);
    const parsed = this.tags.push(normalizeStreamText(body.join('')));
    this.reason('tag', parsed.reasoning, output);
    this.answer(parsed.text, output);
    return output;
  }

  /** 某些兼容站在 SSE 末尾返回完整 message；它是快照，不能再当增量累加。 */
  snapshot(message: OpenAIAssistantPayload): TextDelta[] {
    const decoder = new OpenAIMessageDecoder(this.parseThinkTags);
    decoder.frame = this.frame;
    const snapshot = { ...message };
    // 兼容站的收尾 message 可能只汇总正文；未提供的通道不表示撤销已经收到的思考。
    if (snapshot.content == null) snapshot.content = this.originalContent();
    if (snapshot.reasoning_content == null && snapshot.reasoning == null && this.hasNativeReasoning) {
      snapshot.reasoning_content = this.nativeReasoning;
    }
    if (snapshot.reasoning_details == null && this.details.size) snapshot.reasoning_details = [...this.details.values()];
    decoder.source = this.source;
    decoder.append(snapshot);
    decoder.finish();
    if (message.reasoning_details == null) {
      decoder.detailsUnsafe ||= this.detailsUnsafe;
      decoder.invalidDetailKeys = new Set([...this.invalidDetailKeys, ...decoder.invalidDetailKeys]);
    }
    decoder.nativeReplayTrusted &&= this.nativeReplayTrusted;
    // 可选 details 不能借快照撤销已交付的合法思考；正文／原生通道冲突仍按原契约失败。
    if (this.source === 'details' && decoder.detailsUnsafe && !decoder.reasoningText.startsWith(this.reasoningText)) {
      decoder.reasoningText = this.reasoningText;
    }
    const result = decoder.result();
    const output: TextDelta[] = [];
    this.issues.push(...decoder.issues);
    for (const [type, current, next] of [
      ['reasoning_delta', this.reasoningText, result.reasoningText],
      ['answer_delta', this.contentText, result.contentText],
    ] as const) {
      if (!next.startsWith(current)) throw new Error('模型流式快照与已交付文本冲突');
      const text = next.slice(current.length);
      if (text) output.push({ type, text });
    }
    this.contentText = result.contentText;
    this.reasoningText = result.reasoningText;
    this.tags = decoder.tags;
    this.rawContent = decoder.rawContent;
    this.structured = decoder.structured;
    this.nativeReasoning = decoder.nativeReasoning;
    this.hasNativeReasoning = decoder.hasNativeReasoning;
    this.source = decoder.source;
    this.details = decoder.details;
    this.detailTextLengths = decoder.detailTextLengths;
    this.anonymousDetail = decoder.anonymousDetail;
    this.frame = decoder.frame;
    this.detailsUnsafe = decoder.detailsUnsafe;
    this.invalidDetailKeys = decoder.invalidDetailKeys;
    this.nativeReplayTrusted = decoder.nativeReplayTrusted;
    return output;
  }

  finish(): TextDelta[] {
    const output: TextDelta[] = [];
    const parsed = this.tags.push('', true);
    this.reason('tag', parsed.reasoning, output);
    this.answer(parsed.text, output);
    return output;
  }

  result(): AssistantTextResult {
    const replay: OpenAIReasoningReplay = {};
    if (this.structured || this.tags.recognized) {
      replay.content = this.originalContent();
    }
    // index 用于定位分片，不授权客户端重排模型返回的块序列。
    if (this.details.size && !this.detailsUnsafe) replay.reasoning_details = [...this.details.values()];
    if (this.hasNativeReasoning && (Object.keys(replay).length || this.detailsUnsafe)) replay.reasoning_content = this.nativeReasoning;
    const reasoningReplay = Object.keys(replay).length ? replay : undefined;
    return {
      text: this.contentText, contentText: this.contentText, reasoningText: this.reasoningText,
      source: this.contentText ? 'content' : this.reasoningText ? 'reasoning' : 'empty',
      ...(reasoningReplay ? { reasoningReplay } : {}),
    };
  }

  /** 回放裁决晚于解析，但早于成功终态；工具执行者只会收到通过裁决的模型回合。 */
  complete(context: ReasoningCompletionContext, trimContent = false): AssistantTextResult {
    let result = this.result();
    if (trimContent) {
      const contentText = result.contentText.trim();
      result = { ...result, text: contentText, contentText,
        source: contentText ? 'content' : result.reasoningText ? 'reasoning' : 'empty' };
    }
    if (!this.issues.length) return result;
    const independentReplay = context.replayContract === 'content'
      || context.replayContract === 'native' && (context.thinkingDisabled
        || this.hasNativeReasoning && this.nativeReplayTrusted);
    if (context.hasToolCalls && this.detailsUnsafe && !independentReplay) {
      throw new Error('reasoning_details 损坏，无法安全回放思考载荷，工具调用已阻止');
    }
    if (!context.hasToolCalls && !result.text.trim() && !result.reasoningText.trim()) {
      throw new Error('思考元数据无效，模型没有返回可用的正文或思考');
    }
    return result;
  }

  private reason(source: ReasoningSource, text: string, output: TextDelta[]): void {
    if (!text) return;
    // 同帧原生通道优先；已交付的流只认第一个可读通道，避免镜像字段造成重复展示。
    // 迟到的其他通道仍保留在原始回放载荷中，不重新解释已经交付的事件。
    this.source ??= source;
    if (source !== this.source) return;
    this.reasoningText += text;
    output.push({ type: 'reasoning_delta', text });
  }

  private answer(text: string, output: TextDelta[]): void {
    if (!text) return;
    this.contentText += text;
    output.push({ type: 'answer_delta', text });
  }

  private originalContent(): string | unknown[] {
    if (!this.rawContent.length) return this.contentText;
    return this.rawContent.some(Array.isArray)
      ? this.rawContent.flatMap(part => typeof part === 'string' ? [{ type: 'text', text: part }] : part)
      : this.rawContent.join('');
  }

  private appendDetails(value: unknown): string {
    if (value == null) return '';
    if (!Array.isArray(value)) {
      this.issue('details_not_array', 'reasoning_details');
      return '';
    }
    let text = '';
    for (const [position, delta] of value.entries()) {
      const path = `reasoning_details[${position}]`;
      if (!isObject(delta)) { this.issue('invalid_detail', path); continue; }
      const key = typeof delta.index === 'number' && Number.isInteger(delta.index) && delta.index >= 0
        ? `index:${delta.index}` : typeof delta.id === 'string' ? `id:${delta.id}` : `chunk:${this.anonymousDetail++}`;
      if (this.invalidDetailKeys.has(key)) continue;
      const previous = this.details.get(key);
      if (previous && ((typeof previous.id === 'string' && typeof delta.id === 'string' && previous.id !== delta.id)
        || (typeof previous.type === 'string' && typeof delta.type === 'string' && previous.type !== delta.type))) {
        this.issue('detail_identity_conflict', path);
        this.invalidDetailKeys.add(key);
        continue;
      }
      const type = delta.type ?? previous?.type;
      const readableField = type === 'reasoning.text' ? 'text' : type === 'reasoning.summary' ? 'summary' : null;
      const knownType = readableField !== null || type === 'reasoning.encrypted';
      const fields = [...(readableField ? [readableField] : []), ...(type === 'reasoning.encrypted' ? ['data'] : []), ...(knownType ? ['signature'] : [])];
      const invalidField = fields.find(field => delta[field] != null && typeof delta[field] !== 'string');
      if (invalidField) {
        this.issue('invalid_detail_field', `${path}.${invalidField}`);
        this.invalidDetailKeys.add(key);
        continue;
      }
      const merged = { ...previous, ...delta };
      for (const field of ['id', 'type', 'format', 'index']) {
        if (previous && delta[field] === null && previous[field] != null) merged[field] = previous[field];
      }
      const replacedOpaqueField = previous && Object.keys(delta).find(field => !['text', 'summary', 'data', 'signature'].includes(field)
        && Object.hasOwn(previous, field) && previous[field] != null && merged[field] !== previous[field]
        && JSON.stringify(previous[field]) !== JSON.stringify(merged[field]));
      if (replacedOpaqueField) {
        this.issue('invalid_detail_field', `${path}.${replacedOpaqueField}`);
        this.invalidDetailKeys.add(key);
        continue;
      }
      for (const field of ['text', 'summary', 'data', 'signature']) {
        if (previous && previous[field] != null && delta[field] != null
          && !(typeof previous[field] === 'string' && typeof delta[field] === 'string')
          && JSON.stringify(previous[field]) !== JSON.stringify(delta[field])) {
          this.issue('invalid_detail_field', `${path}.${field}`);
          this.invalidDetailKeys.add(key);
          break;
        }
        if (previous && delta[field] === null && previous[field] != null) merged[field] = previous[field];
        if (previous && typeof previous[field] === 'string') {
          if (typeof delta[field] === 'string') merged[field] = previous[field] + delta[field];
          else if (delta[field] === null) merged[field] = previous[field];
        }
      }
      if (this.invalidDetailKeys.has(key)) continue;
      this.details.set(key, merged);
      const readable = merged.type === 'reasoning.text' ? merged.text
        : merged.type === 'reasoning.summary' ? merged.summary : '';
      if (typeof readable === 'string') {
        text += readable.slice(this.detailTextLengths.get(key) ?? 0);
        this.detailTextLengths.set(key, readable.length);
      }
    }
    return text;
  }

  private issue(code: AIProtocolIssue['code'], path: string): void {
    this.detailsUnsafe = true;
    this.issues.push({ code, path, frame: this.frame });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 延续普通兼容文本节点的既有提取契约；有思考标记的节点先由上层分类。 */
function extractTextFromNode(node: unknown, depth = 0): string {
  if (node == null || depth > 6) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(item => extractTextFromNode(item, depth + 1)).join('');
  if (!isObject(node)) return '';
  return ['text', 'value', 'content', 'output_text', 'parts', 'items', 'chunks', 'segments', 'message']
    .map(key => extractTextFromNode(node[key], depth + 1)).join('');
}

function normalizeStreamText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
}
