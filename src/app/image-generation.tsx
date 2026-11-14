/** 导航执行与丢弃未保存图片的确认属于路由适配。 */
import React, { useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { useIsFocused, useNavigation, usePreventRemove } from '@react-navigation/native';
import { ImageGenerationScreen } from '@features/media';
import { showAppDialog } from '@shared/ui';

export default function ImageGenerationRoute() {
  const router = useRouter();
  const navigation = useNavigation();
  const isActive = useIsFocused();
  const [unsaved, setUnsaved] = useState(false);
  usePreventRemove(unsaved, ({ data }) => {
    showAppDialog({ title: '图片尚未保存', message: '离开会清理暂存图片，图片将丢失。可以留在页面重试保存。', buttons: [
      { text: '留下保存', style: 'cancel' },
      { text: '丢弃并离开', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ] });
  });
  const manage = () => {
    const open = () => router.push('/auxiliary-models/capabilities/image_generation' as Href);
    if (unsaved) showAppDialog({ title: '图片尚未保存', message: '打开模型管理会离开此页，未保存的图片将丢失。', buttons: [
      { text: '留下保存', style: 'cancel' }, { text: '丢弃并继续', style: 'destructive', onPress: open },
    ] });
    else open();
  };
  return <ImageGenerationScreen isActive={isActive} onBack={() => router.back()} onManageModels={manage} onUnsavedImageChange={setUnsaved} />;
}
