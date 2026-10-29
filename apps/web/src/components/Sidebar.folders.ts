import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  layoutThreadFolders,
  type ThreadFolderLayoutRow,
} from "@t3tools/client-runtime/state/thread-folders";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { THREAD_FOLDER_MAX_DEPTH } from "@t3tools/contracts";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  type SidebarListItem,
} from "./Sidebar.logic";

type FolderProject = Pick<EnvironmentProject, "environmentId" | "id" | "threadFolders">;
type FolderThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "threadFolderId"
>;

type FolderBlockRow<P, T> = Exclude<ThreadFolderLayoutRow<P, T>, { kind: "thread" }>;

interface SidebarFolderSegment<P, T> {
  /** Folder and project label rows of the folder block, by list item key. */
  readonly rowByKey: ReadonlyMap<string, FolderBlockRow<P, T>>;
  /** The folder block in visual order: label and folder rows and the threads shown inside. */
  readonly items: readonly SidebarListItem[];
  /** Active threads in visual order: shown folder members, then loose threads. */
  readonly shownThreads: readonly T[];
  /** Active threads outside every folder; they list, drag and reorder as before folders. */
  readonly looseThreads: readonly T[];
}

const NO_FOLDER_ROWS = new Map<string, never>();

/** Splits the Active section into the folder block and the loose threads below it. */
export function buildSidebarFolderSegment<P extends FolderProject, T extends FolderThread>(
  input: Parameters<typeof layoutThreadFolders<P, T>>[0],
): SidebarFolderSegment<P, T> {
  const { rows, looseThreads } = layoutThreadFolders(input);
  if (rows.length === 0) {
    return { rowByKey: NO_FOLDER_ROWS, items: [], shownThreads: looseThreads, looseThreads };
  }
  const rowByKey = new Map<string, FolderBlockRow<P, T>>();
  const items: SidebarListItem[] = [];
  const shownThreads: T[] = [];
  for (const row of rows) {
    if (row.kind === "thread") {
      items.push({ kind: "thread", key: row.key, section: "active", depth: row.depth });
      shownThreads.push(row.thread);
    } else {
      rowByKey.set(row.key, row);
      items.push({ kind: "folder", key: row.key });
    }
  }
  shownThreads.push(...looseThreads);
  return { rowByKey, items, shownThreads, looseThreads };
}

const TREE_INDENT_PX = 12;

/** Another build may nest folders deeper, so indentation stops at this one's limit. */
export function sidebarTreeIndent(depth: number): number {
  return Math.min(depth, THREAD_FOLDER_MAX_DEPTH) * TREE_INDENT_PX;
}

type AttentionThread = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof threadWokeAt>[0] &
  Pick<EnvironmentThreadShell, "settledOverride">;

/** A collapsed folder's dot: a hidden row would show a status that needs the user. */
export function threadNeedsAttention(thread: AttentionThread, snoozeNow: string): boolean {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "working" || status === "waiting") return false;
  if (status !== "ready") return true;
  // As the row decides "Woke": the snooze ended after the last visit.
  const wokeAt = threadWokeAt(thread, { now: snoozeNow });
  const isWoke =
    wokeAt !== null &&
    thread.settledOverride !== "settled" &&
    (thread.lastVisitedAt == null || Date.parse(thread.lastVisitedAt) < Date.parse(wokeAt));
  return isWoke || hasUnseenCompletion(thread);
}
