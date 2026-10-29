import { threadFolderTree } from "@t3tools/client-runtime/state/thread-folders";
import { ThreadFolderId, type ContextMenuItem, type ThreadFolder } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  resolveMoveToFolderChoice,
  type ThreadActionMenuState,
  type ThreadFolderMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("Move to folder", () => {
  const folder = (
    id: string,
    name: string,
    parentFolderId: string | null = null,
  ): ThreadFolder => ({
    id: ThreadFolderId.make(id),
    parentFolderId: parentFolderId === null ? null : ThreadFolderId.make(parentFolderId),
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });
  const tree = threadFolderTree([
    folder("revenue", "Increase revenue"),
    folder("pricing", "Pricing", "revenue"),
    folder("bugs", "Bugs"),
  ]);
  const menu = (folders: Partial<ThreadFolderMenuState> | null, canOperate = true) =>
    buildThreadActionMenuItems({
      ...baseState,
      canOperate,
      folders:
        folders === null
          ? null
          : { tree, currentFolderId: null, inFolder: false, canCreate: true, ...folders },
    }).find((item) => item.id === "move-to-folder");
  const shape = (item: ContextMenuItem<string>): unknown =>
    item.children
      ? { [item.label]: item.children.map(shape) }
      : `${item.label}${item.checked ? " (current)" : ""}${item.disabled ? " (disabled)" : ""}`;

  it("lists folders by name, with a parent's own choice first in its submenu", () => {
    expect(shape(menu({})!)).toEqual({
      "Move to folder": ["Bugs", { "Increase revenue": ["Move here", "Pricing"] }, "New folder…"],
    });
  });

  it("checks and disables the folder the thread is in, and offers to remove it", () => {
    expect(
      shape(menu({ currentFolderId: ThreadFolderId.make("revenue"), inFolder: true })!),
    ).toEqual({
      "Move to folder": [
        "Bugs",
        { "Increase revenue": ["Move here (current) (disabled)", "Pricing"] },
        "Remove from folder",
        "New folder…",
      ],
    });
  });

  it("files a choice into its folder, or the project root for Remove from folder", () => {
    const pricing = menu({})!.children![1]!.children![1]!;
    expect(resolveMoveToFolderChoice(pricing.id)).toBe("pricing");
    expect(resolveMoveToFolderChoice("remove-from-folder")).toBeNull();
    expect(resolveMoveToFolderChoice("new-folder")).toBeUndefined();
  });

  it("disables every folder choice without permission and hides the menu without folders", () => {
    const disabled = (item: ContextMenuItem<string>): boolean =>
      item.disabled === true && (item.children ?? []).every(disabled);
    expect(disabled(menu({}, false)!)).toBe(true);
    expect(menu(null)).toBeUndefined();
  });
});
