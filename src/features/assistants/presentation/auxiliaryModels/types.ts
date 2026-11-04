import { Ionicons } from '@expo/vector-icons';
import type { CapabilityKind } from '../../domain/AuxiliaryModel';

export interface CapabilityEntryItem {
  kind: CapabilityKind;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  description: string;
}

export interface AuxiliaryModelConfigItem {
  id: string;
  capabilityKind: CapabilityKind;
  name: string;
  model: string;
  baseUrl: string;
}

export interface AuxiliaryModelFormData {
  serviceConfigId?: string | null;
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  metadataJson?: string | null;
}
