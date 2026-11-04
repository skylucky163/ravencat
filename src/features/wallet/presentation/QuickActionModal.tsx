/** 快捷记账管理表单，与普通记账复用账本已有分类。 */

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { ModalSheet, showAppDialog } from '@shared/ui';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { QuickAction, WalletCategories, WalletRecordType } from '../domain/WalletRecord';
import { createQuickActionModalStyles } from './styles';

const formatAmount = (amount: number): string => amount.toFixed(2);

interface QuickActionModalProps {
  visible: boolean;
  onClose: () => void;
  quickActions: QuickAction[];
  availableCategories: WalletCategories;
  onAdd: (action: Omit<QuickAction, 'id' | 'sortOrder' | 'createdAt' | 'updatedAt'>) => void;
  onDelete: (id: string) => void;
}

const QuickActionModal: React.FC<QuickActionModalProps> = ({
  visible,
  onClose,
  quickActions,
  availableCategories,
  onAdd,
  onDelete,
}) => {
  const theme = useTheme();
  const styles = useThemedStyles(createQuickActionModalStyles);

  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [category, setCategory] = useState<string>('');
  const [type, setType] = useState<WalletRecordType>('expense');

  const resetForm = () => {
    setName('');
    setAmount('');
    setCategory('');
    setType('expense');
  };

  const handleAdd = () => {
    const parsedAmount = parseFloat(amount);
    if (!name || !amount || parsedAmount <= 0 || !category.trim()) {
      showAppDialog({ title: '提示', message: '请填写完整信息' });
      return;
    }
    onAdd({
      name,
      amount: parsedAmount,
      category: category.trim(),
      detail: '',
      type,
    });
    resetForm();
    setShowAddForm(false);
  };

  const categories = availableCategories[type];

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <View style={styles.content}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.close}>关闭</Text>
            </TouchableOpacity>
            <Text style={styles.title}>快捷记账</Text>
            <TouchableOpacity onPress={() => setShowAddForm(!showAddForm)}>
              <Text style={styles.add}>{showAddForm ? '取消' : '添加'}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {showAddForm && (
              <View style={styles.form}>
                <View style={styles.formRow}>
                  <TextInput
                    style={styles.formInput}
                    value={name}
                    onChangeText={setName}
                    placeholder="名称"
                    placeholderTextColor={theme.colors.text.tertiary}
                  />
                  <TextInput
                    style={[styles.formInput, { flex: 0.6 }]}
                    value={amount}
                    onChangeText={setAmount}
                    keyboardType="decimal-pad"
                    placeholder="金额"
                    placeholderTextColor={theme.colors.text.tertiary}
                  />
                </View>

                <View style={styles.typeSwitch}>
                  <TouchableOpacity
                    style={[styles.typeBtn, type === 'expense' && styles.typeBtnActive]}
                    onPress={() => {
                      setType('expense');
                      if (type !== 'expense') setCategory('');
                    }}
                  >
                    <Text style={type === 'expense' ? styles.typeTextActive : styles.typeText}>
                      支出
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.typeBtn, type === 'income' && styles.typeBtnActive]}
                    onPress={() => {
                      setType('income');
                      if (type !== 'income') setCategory('');
                    }}
                  >
                    <Text style={type === 'income' ? styles.typeTextActive : styles.typeText}>
                      收入
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.categoryGrid}>
                  {categories.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.catBtn, category === cat && styles.catBtnActive]}
                      onPress={() => setCategory(cat)}
                    >
                      <Text style={[styles.catText, category === cat && styles.catTextActive]}>
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.formRow}>
                  <TextInput
                    style={styles.formInput}
                    value={category}
                    onChangeText={setCategory}
                    placeholder="输入自定义分类"
                    placeholderTextColor={theme.colors.text.tertiary}
                  />
                </View>

                <TouchableOpacity style={styles.addBtn} onPress={handleAdd}>
                  <Text style={styles.addBtnText}>添加</Text>
                </TouchableOpacity>
              </View>
            )}

            {quickActions.length === 0 ? (
              <Text style={styles.empty}>暂无快捷记账，点击右上角添加</Text>
            ) : (
              quickActions.map((action) => (
                <View key={action.id} style={styles.item}>
                  <View>
                    <Text style={styles.itemName}>{action.name}</Text>
                    <Text style={styles.itemSub}>
                      {action.category} · {action.type === 'expense' ? '支出' : '收入'}
                    </Text>
                  </View>
                  <View style={styles.itemRight}>
                    <Text style={styles.itemAmount}>¥{formatAmount(action.amount)}</Text>
                    <TouchableOpacity onPress={() => onDelete(action.id)}>
                      <Text style={styles.delete}>删除</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
      </View>
    </ModalSheet>
  );
};

export default QuickActionModal;
