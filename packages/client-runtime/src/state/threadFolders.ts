import {
  resolveLiveThreadFolderId,
  threadFolderDepth,
  THREAD_FOLDER_MAX_DEPTH,
  THREAD_FOLDER_MAX_LIVE,
  type EnvironmentId,
  type ThreadFolder,
  type ThreadFolderId,
} from "@t3tools/contracts";

import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "../environment/scoped.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

type FolderLayoutProject = Pick<EnvironmentProject, "environmentId" | "id" | "threadFolders">;
type FolderLayoutThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "threadFolderId"
>;

export interface ThreadFolderNode {
  readonly folder: ThreadFolder;
  /** 0 for a folder at the project root. */
  readonly depth: number;
  readonly children: ReadonlyArray<ThreadFolderNode>;
}

export type ThreadFolderLayoutRow<P, T> =
  | { readonly kind: "project"; readonly key: string; readonly project: P }
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly project: P;
      readonly folder: ThreadFolder;
      readonly depth: number;
      readonly collapsed: boolean;
      /** Threads anywhere below the folder, shown or not. */
      readonly threadCount: number;
      readonly needsAttention: boolean;
    }
  | { readonly kind: "thread"; readonly key: string; readonly thread: T; readonly depth: number };

export interface ThreadFolderLayout<P, T> {
  /** Project labels, folders and the threads inside them, in visual order. */
  readonly rows: ReadonlyArray<ThreadFolderLayoutRow<P, T>>;
  /** Threads outside every live folder, in input order; they list below the folders. */
  readonly looseThreads: ReadonlyArray<T>;
}

const folderNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const compareFolders = (left: ThreadFolder, right: ThreadFolder) =>
  folderNameCollator.compare(left.name, right.name) || left.id.localeCompare(right.id);

/** Folder collapse is per device, stored under this key. */
export function threadFolderKey(environmentId: EnvironmentId, folderId: ThreadFolderId): string {
  return `${environmentId}:${folderId}`;
}

/** The live folder a thread shows in, or null at the project root. */
export function resolveThreadFolder(
  folders: ReadonlyArray<ThreadFolder> | undefined,
  threadFolderId: ThreadFolderId | null | undefined,
): ThreadFolder | null {
  if (folders === undefined) return null;
  const id = resolveLiveThreadFolderId(folders, threadFolderId);
  return id === null ? null : (folders.find((folder) => folder.id === id) ?? null);
}

/** Whether the server would accept a new folder under `parentFolderId`. */
export function canCreateThreadFolder(
  folders: ReadonlyArray<ThreadFolder> | undefined,
  parentFolderId: ThreadFolderId | null,
): boolean {
  const all = folders ?? [];
  return (
    all.filter((folder) => folder.deletedAt === null).length < THREAD_FOLDER_MAX_LIVE &&
    (parentFolderId === null ||
      resolveLiveThreadFolderId(all, parentFolderId) === parentFolderId) &&
    threadFolderDepth(all, parentFolderId) < THREAD_FOLDER_MAX_DEPTH
  );
}

/** Live folders with siblings by name; a deleted folder's subfolders move up to its parent. */
export function threadFolderTree(
  folders: ReadonlyArray<ThreadFolder> | undefined,
): ReadonlyArray<ThreadFolderNode> {
  if (folders === undefined || folders.length === 0) return [];
  const live = folders.filter((folder) => folder.deletedAt === null).sort(compareFolders);
  const childrenOf = new Map<ThreadFolderId | null, ThreadFolder[]>();
  for (const folder of live) {
    const parentId = resolveLiveThreadFolderId(folders, folder.parentFolderId);
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(folder);
    childrenOf.set(parentId, siblings);
  }
  const placed = new Set<ThreadFolderId>();
  const build = (folder: ThreadFolder, depth: number): ThreadFolderNode => {
    placed.add(folder.id);
    return {
      folder,
      depth,
      children: (childrenOf.get(folder.id) ?? [])
        .filter((child) => !placed.has(child.id))
        .map((child) => build(child, depth + 1)),
    };
  };
  const roots = (childrenOf.get(null) ?? []).map((folder) => build(folder, 0));
  const reachable = roots.length;
  // Folders in a parent cycle never reach the root, so they show at it instead.
  for (const folder of live) {
    if (!placed.has(folder.id)) roots.push(build(folder, 0));
  }
  return roots.length === reachable
    ? roots
    : roots.sort((left, right) => compareFolders(left.folder, right.folder));
}

/**
 * Lays out the Active section: each project's folder tree, then the threads outside it.
 * Pinned, snoozed and settled threads stay on their shelves, so callers leave them out.
 */
export function layoutThreadFolders<
  P extends FolderLayoutProject,
  T extends FolderLayoutThread,
>(input: {
  /** In display order; projects without live folders add no rows. */
  readonly projects: ReadonlyArray<P>;
  /** In display order. */
  readonly threads: ReadonlyArray<T>;
  /** Keys from `threadFolderKey`. */
  readonly collapsedFolderKeys: ReadonlySet<string>;
  /** Stays visible under a collapsed folder, as on a collapsed shelf. */
  readonly openThreadKey: string | null;
  /** Labels each project's folders even when only one has any, for lists that mix projects. */
  readonly labelProjects: boolean;
  readonly needsAttention?: (thread: T) => boolean;
}): ThreadFolderLayout<P, T> {
  const sections = new Map<
    string,
    {
      readonly project: P;
      readonly tree: ReadonlyArray<ThreadFolderNode>;
      readonly members: Map<ThreadFolderId, T[]>;
    }
  >();
  for (const project of input.projects) {
    const tree = threadFolderTree(project.threadFolders);
    if (tree.length === 0) continue;
    sections.set(scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), {
      project,
      tree,
      members: new Map(),
    });
  }
  if (sections.size === 0) return { rows: [], looseThreads: input.threads };
  const labelProjects = input.labelProjects || sections.size > 1;

  const looseThreads: T[] = [];
  for (const thread of input.threads) {
    const section = sections.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    const liveId =
      section === undefined || thread.threadFolderId == null
        ? null
        : resolveLiveThreadFolderId(section.project.threadFolders ?? [], thread.threadFolderId);
    if (section === undefined || liveId === null) {
      looseThreads.push(thread);
      continue;
    }
    const members = section.members.get(liveId) ?? [];
    members.push(thread);
    section.members.set(liveId, members);
  }

  const threadKey = (thread: T) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const rows: ThreadFolderLayoutRow<P, T>[] = [];
  for (const [projectKey, { project, tree, members }] of sections) {
    if (labelProjects) rows.push({ kind: "project", key: projectKey, project });
    const summaries = new Map<
      ThreadFolderNode,
      { readonly threadCount: number; readonly needsAttention: boolean; readonly open?: T }
    >();
    const summarize = (node: ThreadFolderNode) => {
      const cached = summaries.get(node);
      if (cached !== undefined) return cached;
      const own = members.get(node.folder.id) ?? [];
      let threadCount = own.length;
      let needsAttention = own.some((thread) => input.needsAttention?.(thread) === true);
      let open = own.find((thread) => threadKey(thread) === input.openThreadKey);
      for (const child of node.children) {
        const summary = summarize(child);
        threadCount += summary.threadCount;
        needsAttention ||= summary.needsAttention;
        open ??= summary.open;
      }
      const summary = { threadCount, needsAttention, ...(open === undefined ? {} : { open }) };
      summaries.set(node, summary);
      return summary;
    };
    const emit = (node: ThreadFolderNode) => {
      const key = threadFolderKey(project.environmentId, node.folder.id);
      const { threadCount, needsAttention, open } = summarize(node);
      const collapsed = input.collapsedFolderKeys.has(key);
      rows.push({
        kind: "folder",
        key,
        project,
        folder: node.folder,
        depth: node.depth,
        collapsed,
        threadCount,
        needsAttention,
      });
      if (collapsed) {
        if (open !== undefined) {
          rows.push({ kind: "thread", key: threadKey(open), thread: open, depth: node.depth + 1 });
        }
        return;
      }
      for (const child of node.children) emit(child);
      for (const thread of members.get(node.folder.id) ?? []) {
        rows.push({ kind: "thread", key: threadKey(thread), thread, depth: node.depth + 1 });
      }
    };
    for (const node of tree) emit(node);
  }
  return { rows, looseThreads };
}
