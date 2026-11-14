import React, { type ReactNode } from 'react';
import { Text } from 'react-native';
import { useTheme } from '@shared/theme';

/** 分组不增加原生布局层，字段的错误定位仍相对滚动内容计算。 */
export default function ModelFormSection({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return <>
    <Text style={{ color: theme.colors.text.secondary, fontSize: 12, fontWeight: '600', letterSpacing: 0.6,
      marginTop: theme.spacing.md, marginBottom: theme.spacing.md }}>{title}</Text>
    {children}
  </>;
}
