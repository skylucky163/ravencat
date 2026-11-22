import { createProtocolEditor } from './application/ProtocolEditor';
import { protocolRepository } from './infrastructure/SQLiteProtocolRepository';
import ProtocolView, { type ProtocolViewProps } from './presentation/ProtocolView';

const editor = createProtocolEditor(protocolRepository);

export default function ProtocolScreen(props: Omit<ProtocolViewProps, 'editor'>) {
  return <ProtocolView {...props} editor={editor} />;
}
