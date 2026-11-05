/** 其他规则复用独立列表与正文编辑路由。 */
import PromptCenterRouteContent from '@host/navigation/PromptCenterRouteContent';

export default function OtherRulesRoute() {
  return <PromptCenterRouteContent page={{ kind: 'otherRules' }} />;
}
