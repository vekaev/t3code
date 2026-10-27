import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadFolderKey } from "@t3tools/client-runtime/state/thread-folders";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  type ProjectIconOverride,
  type ScopedProjectRef,
  type ThreadFolder,
  ThreadFolderId,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { randomUUID } from "../lib/utils";
import { projectEnvironment } from "../state/projects";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { showThreadUndoNotice } from "./showThreadUndoNotice";

/**
 * The folder row whose name is being edited, by `threadFolderKey`. Shared so the chat
 * header's "New folder…" opens the name in the sidebar.
 */
export const useThreadFolderRename = create<{ readonly key: string | null }>(() => ({
  key: null,
}));

export function startThreadFolderRename(key: string) {
  useThreadFolderRename.setState({ key });
}

export function cancelThreadFolderRename() {
  useThreadFolderRename.setState({ key: null });
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
      }),
    );
  }
  return false;
}

export function useThreadFolderActions() {
  const createFolder = useOrchestrationCommand(projectEnvironment.createThreadFolder, {
    reportFailure: false,
  });
  const updateFolder = useOrchestrationCommand(projectEnvironment.updateThreadFolder, {
    reportFailure: false,
  });
  const deleteFolder = useOrchestrationCommand(projectEnvironment.deleteThreadFolder, {
    reportFailure: false,
  });
  const restoreFolder = useOrchestrationCommand(projectEnvironment.restoreThreadFolder, {
    reportFailure: false,
  });

  /** Creates "New folder" and opens its name for editing; null when it failed. */
  const createThreadFolder = async (
    projectRef: ScopedProjectRef,
    parentFolderId: ThreadFolderId | null,
  ): Promise<ThreadFolderId | null> => {
    const folderId = ThreadFolderId.make(randomUUID());
    const result = await createFolder({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        folderId,
        parentFolderId,
        name: m(msg("New folder", { $context: "default name of a new folder" })),
      },
    });
    if (!reportFailure(m(msg("Failed to create folder")), result)) return null;
    startThreadFolderRename(threadFolderKey(projectRef.environmentId, folderId));
    return folderId;
  };

  const renameThreadFolder = async (
    projectRef: ScopedProjectRef,
    folder: Pick<ThreadFolder, "id" | "name">,
    name: string,
  ) => {
    cancelThreadFolderRename();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: m(msg("Folder name cannot be empty")) });
      return;
    }
    if (trimmed === folder.name) return;
    reportFailure(
      m(msg("Failed to rename folder")),
      await updateFolder({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, folderId: folder.id, name: trimmed },
      }),
    );
  };

  const setThreadFolderIcon = async (
    projectRef: ScopedProjectRef,
    folderId: ThreadFolderId,
    icon: ProjectIconOverride | null,
  ) => {
    reportFailure(
      m(msg("Failed to change folder icon")),
      await updateFolder({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, folderId, icon },
      }),
    );
  };

  /** Its threads and subfolders show one level up until Undo restores it. */
  const deleteThreadFolder = async (projectRef: ScopedProjectRef, folderId: ThreadFolderId) => {
    const input = { projectId: projectRef.projectId, folderId };
    const claim = ThreadUndo.begin(
      "folder-delete",
      threadFolderKey(projectRef.environmentId, folderId),
    );
    const result = await deleteFolder({ environmentId: projectRef.environmentId, input });
    if (!reportFailure(m(msg("Failed to delete folder")), result)) {
      claim.finish();
      return;
    }
    showThreadUndoNotice({
      action: "Deleted",
      claim,
      undo: () => restoreFolder({ environmentId: projectRef.environmentId, input }),
      failureTitle: m(msg("Failed to restore folder")),
    });
  };

  return { createThreadFolder, renameThreadFolder, setThreadFolderIcon, deleteThreadFolder };
}
