/** 弹窗只拥有展示队列；业务结果、错误解释和操作回调仍由调用方拥有。 */
export type AppDialogTone = 'info' | 'success' | 'warning' | 'error';

export interface AppDialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  /** 危险按钮可用实色背景强调不可恢复的操作。 */
  emphasis?: 'normal' | 'strong';
  onPress?: () => void;
}

export interface AppDialogOptions {
  title: string;
  message?: string;
  tone?: AppDialogTone;
  buttons?: readonly AppDialogButton[];
  /** 返回键和遮罩只关闭提示，不执行任何操作按钮。 */
  dismissible?: boolean;
  onDismiss?: () => void;
}

const queue: AppDialogOptions[] = [];
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

export function showAppDialog(options: AppDialogOptions): void {
  // 每次展示拥有独立身份，同一份提示配置再次展示也不能被旧触摸关闭。
  queue.push({ ...options });
  emitChange();
}

export function subscribeAppDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getAppDialogSnapshot(): AppDialogOptions | null {
  return queue[0] ?? null;
}

export function finishAppDialog(dialog: AppDialogOptions, button?: AppDialogButton): void {
  // 原生触摸可能在重绘前重复到达；已关闭弹窗的回调不能再提交一次业务操作。
  if (queue[0] !== dialog) return;
  queue.shift();
  emitChange();
  if (button) button.onPress?.();
  else dialog.onDismiss?.();
}

export function clearAppDialogs(): void {
  // 展示宿主卸载（包括清空应用数据）后，不保留旧页面的闭包，也不触发业务操作。
  queue.length = 0;
  emitChange();
}
