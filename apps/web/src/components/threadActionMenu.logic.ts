import { type ContextMenuItem, ThreadFolderId } from "@t3tools/contracts";
import type { ThreadFolderNode } from "@t3tools/client-runtime/state/thread-folders";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "move-to-folder"
  | `move-to-folder:${string}`
  | `folder-submenu:${string}`
  | "remove-from-folder"
  | "new-folder"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

type ThreadFolderMenuId =
  | "new-subfolder"
  | "rename-folder"
  | "change-folder-icon"
  | "remove-folder-icon"
  | "delete-folder";

export function buildThreadFolderMenuItems(options: {
  readonly canOperate: boolean;
  readonly canCreateSubfolder: boolean;
  readonly hasIcon: boolean;
}): ReadonlyArray<ContextMenuItem<ThreadFolderMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadFolderMenuId>> = [
    {
      id: "new-subfolder",
      label: "New subfolder",
      icon: "folder-plus",
      disabled: !options.canCreateSubfolder,
    },
    { id: "rename-folder", label: "Rename folder", icon: "pencil" },
    { id: "change-folder-icon", label: "Change icon…", icon: "smile-plus" },
    ...(options.hasIcon ? [{ id: "remove-folder-icon" as const, label: "Remove icon" }] : []),
    {
      id: "delete-folder",
      label: "Delete folder",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
  return options.canOperate ? items : items.map((item) => ({ ...item, disabled: true }));
}

export interface ThreadFolderMenuState {
  /** The project's live folders, from `threadFolderTree`. */
  readonly tree: ReadonlyArray<ThreadFolderNode>;
  /** Checked and disabled: every thread already shows in it. */
  readonly currentFolderId: ThreadFolderId | null;
  /** Some thread shows in a folder. */
  readonly inFolder: boolean;
  readonly canCreate: boolean;
}

const MOVE_TO_FOLDER_PREFIX = "move-to-folder:";

/** The folder a "Move to folder" choice files into; null is the project root. */
export function resolveMoveToFolderChoice(action: string): ThreadFolderId | null | undefined {
  if (action === "remove-from-folder") return null;
  return action.startsWith(MOVE_TO_FOLDER_PREFIX)
    ? ThreadFolderId.make(action.slice(MOVE_TO_FOLDER_PREFIX.length))
    : undefined;
}

// Electron cannot click a menu item that opens a submenu, so a folder with subfolders
// lists itself first as "Move here".
function moveToFolderItem(
  node: ThreadFolderNode,
  currentFolderId: ThreadFolderId | null,
): ContextMenuItem<ThreadActionMenuId> {
  const current = node.folder.id === currentFolderId;
  const target = {
    id: `${MOVE_TO_FOLDER_PREFIX}${node.folder.id}` as const,
    label: node.children.length === 0 ? node.folder.name : "Move here",
    ...(current ? { checked: true, disabled: true } : {}),
  };
  if (node.children.length === 0) return target;
  return {
    id: `folder-submenu:${node.folder.id}`,
    label: node.folder.name,
    children: [
      target,
      ...node.children.map((child, index) => ({
        ...moveToFolderItem(child, currentFolderId),
        ...(index === 0 ? { separatorBefore: true } : {}),
      })),
    ],
  };
}

export function buildMoveToFolderMenuItem(
  state: ThreadFolderMenuState,
  count?: number,
): ContextMenuItem<ThreadActionMenuId> {
  const actions: ContextMenuItem<ThreadActionMenuId>[] = [
    ...(state.inFolder
      ? [{ id: "remove-from-folder" as const, label: "Remove from folder", icon: "folder-output" }]
      : []),
    { id: "new-folder", label: "New folder…", icon: "folder-plus", disabled: !state.canCreate },
  ];
  return {
    id: "move-to-folder",
    label: count === undefined ? "Move to folder" : `Move to folder (${count})`,
    icon: "folder-input",
    children: [
      ...state.tree.map((node) => moveToFolderItem(node, state.currentFolderId)),
      ...actions.map((item, index) =>
        index === 0 && state.tree.length > 0 ? { ...item, separatorBefore: true } : item,
      ),
    ],
  };
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  /** Absent when the environment has no folders. */
  readonly folders?: ThreadFolderMenuState | null;
}

function disableMenuItem<T extends string>(item: ContextMenuItem<T>): ContextMenuItem<T> {
  return {
    ...item,
    disabled: true,
    ...(item.children ? { children: item.children.map(disableMenuItem) } : {}),
  };
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...(state.folders ? [buildMoveToFolderMenuItem(state.folders)] : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) => (threadActionRequiresOperate(item.id) ? disableMenuItem(item) : item));
}
