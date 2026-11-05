/** 资产列表可承载业务系统的选择控件，选择所有权仍归对应系统。 */
import React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles } from '@shared/theme';
import { EmptyState, HeaderAddButton, ListItem, NavigationHeader } from '@shared/ui';
import type { AuxiliaryModelConfigItem } from './types';
import { createStyles } from './styles';

interface Props {
  label: string;
  description: string;
  models: AuxiliaryModelConfigItem[];
  loading: boolean;
  onBack(): void;
  onAddModel(): void;
  onEditModel(id: string): void;
  selection?: React.ReactNode;
}
export default function AuxiliaryModelPoolScreen({ label, description, models, loading, onBack, onAddModel, onEditModel, selection }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  return <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
    <NavigationHeader title={label} onGoBack={onBack} help={{ sections: [
      { title: '用途', body: description },
      { title: '选择规则', body: '实际使用的模型由对应功能选择；后续新增配置不会覆盖已有选择。' },
    ] }} rightButton={<HeaderAddButton accessibilityLabel="新增模型配置" onPress={onAddModel} />} />
    {loading ? <View style={styles.stateCard}><ActivityIndicator color={theme.colors.brand.primary} /></View> : <ScrollView style={styles.scrollView}>
      {selection && <View style={[styles.sectionBlock, styles.selectionBlock]}>{selection}</View>}
      <View style={styles.sectionBlock}>{models.length === 0 ? <EmptyState title={`暂无${label}`} description="点击右上角 + 创建模型配置。" /> : <View style={styles.card}>
        {models.map((model, index) => <ListItem key={model.id} title={model.name} subtitle={model.model} onPress={() => onEditModel(model.id)}
          style={index === models.length - 1 ? styles.itemLast : undefined} />)}
      </View>}</View><View style={styles.bottomGap} />
    </ScrollView>}
  </SafeAreaView>;
}
