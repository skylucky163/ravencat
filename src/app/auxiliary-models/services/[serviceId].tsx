/** 服务编辑路由，只向 Feature 传服务标识。 */
import { useLocalSearchParams } from 'expo-router';
import AuxiliaryModelsRouteContent from '@host/navigation/AuxiliaryModelsRouteContent';
export default function ModelServiceRoute() {
  const { serviceId } = useLocalSearchParams<{ serviceId: string }>();
  return <AuxiliaryModelsRouteContent route={{ screen: 'service-edit', serviceId: serviceId === 'new' ? undefined : serviceId }} />;
}
