/** 数据管理路由负责导航与全应用清理命令的装配。 */
import { useRouter, type Href } from 'expo-router';
import { useChatRouter } from '@features/chat';
import { DataManagementScreen } from '@features/profile';
import { createBackupRuntime } from '@host';

const backupRuntime = createBackupRuntime();

export default function DataManagementRoute() {
  const router = useRouter();
  const { resetApplicationData } = useChatRouter();
  return <DataManagementScreen onBack={() => router.back()}
    onOpenAIRecycleBin={() => router.push('/ai-recycle-bin' as Href)}
    backupRuntime={backupRuntime} onClearData={resetApplicationData} />;
}
