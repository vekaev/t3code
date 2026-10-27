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
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { projectEnvironment } from "../state/projects";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { showThreadUndoNotice } from "./showThreadUndoNotice";

const NEW_FOLDER_NAME = "New folder";

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
        description: error instanceof Error ? error.message : "An error occurred.",
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
        name: NEW_FOLDER_NAME,
      },
    });
    if (!reportFailure("Failed to create folder", result)) return null;
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
      toastManager.add({ type: "warning", title: "Folder name cannot be empty" });
      return;
    }
    if (trimmed === folder.name) return;
    reportFailure(
      "Failed to rename folder",
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
      "Failed to change folder icon",
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
    if (!reportFailure("Failed to delete folder", result)) {
      claim.finish();
      return;
    }
    showThreadUndoNotice({
      action: "Deleted",
      claim,
      undo: () => restoreFolder({ environmentId: projectRef.environmentId, input }),
      failureTitle: "Failed to restore folder",
    });
  };

  return { createThreadFolder, renameThreadFolder, setThreadFolderIcon, deleteThreadFolder };
}
