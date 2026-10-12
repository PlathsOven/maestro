import SharedAskCard from '../../shared/ui/AskCard';
import { useApp } from '../store/app';
import { tryInvoke } from '../lib/api';
import { MAX_ATTACHMENT_BYTES, fileToBase64 } from './common';
import type { AskQuestionPayload } from '../../shared/types';

/**
 * Thin wrapper over the shared AskCard (web-desktop-parity spec §2.5): reads the
 * live ask payload from the store and resolves it over IPC. The presentational
 * card lives in src/shared/ui/AskCard.tsx so the web renders the same picker.
 * Files attached to an answer are saved into the worktree like composer
 * attachments; the agent gets their paths.
 */
export default function AskCard({ payload }: { payload: AskQuestionPayload }) {
  const { workspaceId, agentId, askId, questions } = payload;
  const attach = async (files: File[]) => {
    const paths = await Promise.all(
      files.slice(0, 10).map(async (f) => {
        if (f.size > MAX_ATTACHMENT_BYTES) {
          useApp.getState().toast('error', `${f.name} is larger than 25MB`);
          return null;
        }
        const { data, error } = await tryInvoke('attachment:save', { workspaceId, name: f.name, dataBase64: await fileToBase64(f) });
        if (error) useApp.getState().toast('error', error);
        return data?.path ?? null;
      })
    );
    return paths.filter((p): p is string => !!p);
  };
  return (
    <SharedAskCard
      questions={questions}
      onAnswer={(answers) => useApp.getState().answerAsk(workspaceId, agentId, askId, answers)}
      onSkip={() => useApp.getState().answerAsk(workspaceId, agentId, askId, [], true)}
      onAttach={attach}
    />
  );
}
