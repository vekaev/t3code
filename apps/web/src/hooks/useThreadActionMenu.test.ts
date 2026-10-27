import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  completed: deferred<void>(),
  foldersSupported: false,
  boringSidebar: false,
  archivedAt: null as string | null,
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsThreadFolders: () => state.foldersSupported,
  readProject: () => ({
    threadFolders: [
      {
        id: "plans",
        parentFolderId: null,
        name: "Plans",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
  }),
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
    threadFolderId: "plans",
    archivedAt: state.archivedAt,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => state.completed.resolve() },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
  useBoringSidebarEnabled: () => state.boringSidebar,
}));
vi.mock("./useThreadFolderActions", () => ({
  useThreadFolderActions: () => ({
    createThreadFolder: async () => {
      state.effects.push("create-folder");
      return "made";
    },
  }),
}));
vi.mock("./useThreadActions", () => ({
  canTurnThreadIntoProject: () => false,
  useThreadActions: () => ({
    ...Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
    moveThreadToFolder: async (
      _target: unknown,
      folderId: string | null,
      options?: { readonly deleteFolderOnUndo?: boolean },
    ) => {
      recordEffect(`move:${folderId}${options?.deleteFolderOnUndo ? ":undo-deletes" : ""}`);
      return AsyncResult.success(undefined);
    },
  }),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = (options: { readonly onFind?: (threadRef: typeof target) => void } = {}) =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    onFind: options.onFind,
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.completed = deferred<void>();
  state.foldersSupported = false;
  state.boringSidebar = false;
  state.archivedAt = null;
  state.show.mockReset().mockResolvedValue(null);
});

const shownMenuIds = () => state.show.mock.calls[0]?.[0].map((item) => item.id) ?? [];

describe("thread menu permissions", () => {
  it.each(["rename", "regenerate-title", "delete", "pin", "settle", "archive"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );

  it("offers find only to a header that can open it, without task permission", async () => {
    createMenu().openMenu(position);
    expect(state.show.mock.calls[0]![0].some((item) => item.id === "find")).toBe(false);
    state.show.mockResolvedValue("find");
    const onFind = vi.fn(() => recordEffect("find"));
    createMenu({ onFind }).openMenu(position);
    await state.completed.promise;
    const items = state.show.mock.calls[1]![0];
    expect(items[0]).toMatchObject({ id: "find", label: "Find in thread" });
    expect(items[0]?.disabled).not.toBe(true);
    expect(state.effects).toEqual(["find"]);
    expect(onFind).toHaveBeenCalledExactlyOnceWith(target);
  });
});

describe("thread menu folders", () => {
  it.each([
    ["move-to-folder:plans", ["move:plans"]],
    ["remove-from-folder", ["move:null"]],
    ["new-folder", ["create-folder", "move:made:undo-deletes"]],
  ] as const)("%s files the thread", async (action, effects) => {
    state.granted.add("secondary");
    state.foldersSupported = true;
    state.show.mockResolvedValue(action);
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(shownMenuIds()).toContain("move-to-folder");
    expect(state.effects).toEqual(effects);
  });

  it.each([
    ["an archived thread", () => (state.archivedAt = "2026-01-02T00:00:00.000Z")],
    ["the boring sidebar, which shows no folder rows", () => (state.boringSidebar = true)],
  ])("leaves Move to folder out for %s", async (_, arrange) => {
    state.granted.add("secondary");
    state.foldersSupported = true;
    arrange();
    state.show.mockImplementation(async () => {
      state.completed.resolve();
      return null;
    });
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(shownMenuIds()).not.toContain("move-to-folder");
  });
});
