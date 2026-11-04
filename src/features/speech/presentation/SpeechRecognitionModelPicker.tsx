import React from 'react';
import { ConfiguredModelPicker } from '@shared/ui';
import { getSpeechRecognitionModelSettings, selectSpeechRecognitionModel, subscribeSpeechRecognitionModelsChanged } from '../application/SpeechRecognitionModels';

export function SpeechRecognitionModelPicker() {
  return <ConfiguredModelPicker title="语音识别模型"
    getSettings={getSpeechRecognitionModelSettings} onSelect={selectSpeechRecognitionModel}
    subscribeChanged={subscribeSpeechRecognitionModelsChanged} />;
}
