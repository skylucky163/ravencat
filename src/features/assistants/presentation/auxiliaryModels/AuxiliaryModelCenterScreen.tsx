// 辅助模型中心 — 能力列表首页

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, ThemedSurface } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { ListItem } from '@shared/ui';
import { createStyles } from './styles';
import type { CapabilityKind } from '../../domain/AuxiliaryModel';
import type { CapabilityEntryItem } from './types';

interface AuxiliaryModelCenterScreenProps {
  capabilityItems: CapabilityEntryItem[];
  loading?: boolean;
  onBack: () => void;
  onOpenServices(): void;
  onOpenCapabilityPool: (kind: CapabilityKind) => void;
}

export default function AuxiliaryModelCenterScreen({
  capabilityItems,
  loading = false,
  onBack,
  onOpenServices,
  onOpenCapabilityPool,
}: AuxiliaryModelCenterScreenProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (loading) {
    return (
      <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
        <NavigationHeader title="辅助模型中心" onGoBack={onBack} />
        <View style={styles.stateCard}>
          <ActivityIndicator size="large" color={theme.colors.brand.primary} />
          <Text style={styles.stateText}>正在加载辅助模型配置…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
      <NavigationHeader title="辅助模型中心" onGoBack={onBack} />
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.sectionBlock}>
          <ThemedSurface variant="card" style={styles.card}>
            <ListItem title="服务配置" leftIcon={<Ionicons name="server-outline" size={20} color={theme.colors.brand.primary} />} showArrow onPress={onOpenServices} />
          </ThemedSurface>
        </View>
        <Text style={{ color: theme.colors.text.secondary, marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.md }}>模型用途</Text>
        <View style={styles.sectionBlock}>
          <ThemedSurface variant="card" style={styles.card}>
            {capabilityItems.map((item) => (
              <ListItem
                key={item.kind}
                title={item.label}
                leftIcon={<Ionicons name={item.icon} size={20} color={item.iconColor} />}
                showArrow
                onPress={() => onOpenCapabilityPool(item.kind)}
              />
            ))}
          </ThemedSurface>
        </View>
        <View style={styles.bottomGap} />
      </ScrollView>
    </SafeAreaView>
  );
}
