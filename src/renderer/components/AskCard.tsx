import SharedAskCard from '../../shared/ui/AskCard';
import { useApp } from '../store/app';
import type { AskQuestionPayload } from '../../shared/types';

/**
 * Thin wrapper over the shared AskCard (web-desktop-parity spec §2.5): reads the
 * live ask payload from the store and resolves it over IPC. The presentational
 * card lives in src/shared/ui/AskCard.tsx so the web renders the same picker.
 */
export default function AskCard({ payload }: { payload: AskQuestionPayload }) {
  const { workspaceId, agentId, askId, questions } = payload;
  return (
    <SharedAskCard
      questions={questions}
      onAnswer={(answers) => useApp.getState().answerAsk(workspaceId, agentId, askId, answers)}
      onSkip={() => useApp.getState().answerAsk(workspaceId, agentId, askId, [], true)}
    />
  );
}
