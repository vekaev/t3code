import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { THREAD_FOLDER_NAME_MAX_LENGTH, type ThreadFolder } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, GitForkIcon } from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { sidebarTreeIndent } from "../Sidebar.folders";
import { animateSidebarLayoutChanges, sidebarListItemId } from "../Sidebar.logic";
import { ProjectFavicon, ProjectIconGlyph, type ProjectFaviconProject } from "../ProjectFavicon";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

const COLLAPSED_FOLDERS_KEY = "t3code:sidebar:collapsed-thread-folders";
const CollapsedFolderKeys = Schema.Array(Schema.String);
const NO_COLLAPSED_FOLDERS: typeof CollapsedFolderKeys.Type = [];

/** Collapse is per device, by `threadFolderKey`; folders start expanded. */
export function useCollapsedThreadFolders() {
  const [stored, setStored] = useLocalStorage(
    COLLAPSED_FOLDERS_KEY,
    NO_COLLAPSED_FOLDERS,
    CollapsedFolderKeys,
  );
  const collapsedFolderKeys: ReadonlySet<string> = new Set(stored);
  const setFolderCollapsed = (key: string, collapsed: boolean) =>
    setStored((current) =>
      current.includes(key) === collapsed
        ? current
        : collapsed
          ? [...current, key]
          : current.filter((candidate) => candidate !== key),
    );
  return { collapsedFolderKeys, setFolderCollapsed };
}

// Folder block rows sit in the sortable list so dragged threads slide past them.
function SortableFolderBlockRow(props: {
  rowKey: string;
  depth: number;
  "data-testid": string;
  children: ReactNode;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarListItemId({ kind: "folder", key: props.rowKey }),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className="list-none"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
        paddingInlineStart: sidebarTreeIndent(props.depth),
      }}
    >
      {props.children}
    </li>
  );
}

// Mounted only while renaming, so each rename starts from the current name.
function FolderNameInput(props: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.name);
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={name}
      dir="auto"
      maxLength={THREAD_FOLDER_NAME_MAX_LENGTH}
      aria-label="Folder name"
      onChange={(event) => setName(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit(name);
      }}
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

function ThreadFolderGlyph(props: { folder: ThreadFolder; collapsed: boolean }) {
  if (props.folder.icon) return <ProjectIconGlyph icon={props.folder.icon} className="size-4" />;
  const Icon =
    props.folder.forkRootThreadId != null
      ? GitForkIcon
      : props.collapsed
        ? FolderIcon
        : FolderOpenIcon;
  return <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />;
}

export const SidebarFolderRow = memo(function SidebarFolderRow(props: {
  rowKey: string;
  folder: ThreadFolder;
  /** 0 at the project root. */
  depth: number;
  collapsed: boolean;
  /** Threads anywhere inside, shown while collapsed. */
  threadCount: number;
  needsAttention: boolean;
  isRenaming: boolean;
  onSetCollapsed: (key: string, collapsed: boolean) => void;
  onContextMenu: (key: string, position: { x: number; y: number }) => void;
  onStartRename: (key: string) => void;
  onCommitRename: (key: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const { collapsed, folder, isRenaming, onContextMenu, onSetCollapsed, onStartRename, rowKey } =
    props;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    // The sidebar tree owns arrows and the context menu key; the row keeps the rest.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSetCollapsed(rowKey, !collapsed);
    } else if (event.key === "F2") {
      event.preventDefault();
      onStartRename(rowKey);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(rowKey, { x: event.clientX, y: event.clientY });
  };
  const threadCountLabel = `${props.threadCount} thread${props.threadCount === 1 ? "" : "s"}`;
  // Its threads name the folder in their labels rather than nesting under it in the tree.
  return (
    <SortableFolderBlockRow rowKey={rowKey} depth={props.depth} data-testid="sidebar-folder-row">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`folder:${rowKey}`}
        aria-expanded={!collapsed}
        aria-label={
          collapsed
            ? `${folder.name} folder, ${threadCountLabel}${props.needsAttention ? ", needs attention" : ""}`
            : `${folder.name} folder`
        }
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onSetCollapsed(rowKey, !collapsed)}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 text-sidebar-muted-foreground", !collapsed && "rotate-90")}
        />
        <ThreadFolderGlyph folder={folder} collapsed={collapsed} />
        {isRenaming ? (
          <FolderNameInput
            name={folder.name}
            onCommit={(name) => props.onCommitRename(rowKey, name)}
            onCancel={props.onCancelRename}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
            {folder.name}
          </span>
        )}
        {collapsed && props.needsAttention ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : null}
        {collapsed ? (
          <span aria-hidden className="shrink-0 text-xs tabular-nums text-secondary-label">
            {props.threadCount}
          </span>
        ) : null}
      </div>
    </SortableFolderBlockRow>
  );
});

/** Names the project whose folders follow, when the list mixes projects. */
export const SidebarFolderProjectLabel = memo(function SidebarFolderProjectLabel(props: {
  rowKey: string;
  project: ProjectFaviconProject;
  label: string;
}) {
  return (
    <SortableFolderBlockRow rowKey={props.rowKey} depth={0} data-testid="sidebar-folder-project">
      <div className="flex h-7 items-center gap-2 px-2.5 pt-1 text-xs font-medium text-sidebar-muted-foreground">
        <ProjectFavicon project={props.project} className="size-3.5" />
        <span className="min-w-0 truncate">{props.label}</span>
      </div>
    </SortableFolderBlockRow>
  );
});
