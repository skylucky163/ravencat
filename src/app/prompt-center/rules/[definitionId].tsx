/** 编辑条目以业务标识进入路由；未知外部地址回到概览。 */
import { Redirect, useLocalSearchParams } from 'expo-router';
import PromptCenterRouteContent from '@host/navigation/PromptCenterRouteContent';

export default function PromptRuleRoute() {
  const { definitionId } = useLocalSearchParams<{ definitionId: string }>();
  return definitionId === 'foundation.default_core' || definitionId === 'output.paragraph_breaks' || definitionId === 'input.image_grounding'
    || definitionId === 'internal.chat_summary' || definitionId === 'internal.chat_secondary_summary'
    || definitionId === 'internal.vision_ocr'
    ? <PromptCenterRouteContent page={{ kind: 'editor', definitionId }} />
    : <Redirect href="/prompt-center" />;
}
