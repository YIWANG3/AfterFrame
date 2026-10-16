// The gallery's right-click menu: its items, the submenus a few of them open,
// and the menu itself, portaled to the body and kept inside the window.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FolderPlus, FolderMinus, Folder, ChevronRight, Columns2, LayoutGrid, Eye, LocateFixed, Pencil, Trash2, Trash, Sparkles, Link2, Type, ExternalLink, RefreshCw, Flag, FlagOff, Tag, X, Copy, ScanSearch } from "lucide-react";
import api from "../api";
import { Z } from "../ui";
import useDismiss from "../ui/useDismiss";
import { LOCKED_HINT_KEY } from "./DesktopOnly";
import { formatKeys, shortcutLabel } from "../shortcuts/store";

function MenuItem({ icon: Icon, label, shortcut, onClick, locked = false, children }) {
  const { t: tc } = useTranslation("common");
  const [subOpen, setSubOpen] = useState(false);
  const timerRef = useRef(null);
  // Locked = desktop-only on this bridge: stays visible (so the entry
  // advertises the desktop app), loses its submenu, and clicks open the
  // download page.
  const hasSub = !!children && !locked;

  function enterItem() {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (hasSub) setSubOpen(true);
  }
  function leaveItem() {
    timerRef.current = setTimeout(() => setSubOpen(false), 200);
  }

  if (hasSub) {
    return (
      <div className="relative" onMouseEnter={enterItem} onMouseLeave={leaveItem}>
        <button
          type="button"
          className="flex w-full cursor-pointer rounded-md items-center justify-between px-3 py-1.5 text-[12px] text-muted hover:bg-hover hover:text-text"
          onClick={onClick}
        >
          <span className="flex items-center gap-2.5">
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {label}
          </span>
          <ChevronRight className="h-3 w-3 text-muted2" />
        </button>
        {subOpen && (
          <div className="absolute left-full top-0 z-50 ml-1 w-max min-w-[160px] rounded-md border border-border/60 bg-chrome p-1 shadow-menu">
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={[
        "flex w-full rounded-md items-center justify-between px-3 py-1.5 text-left text-[12px]",
        locked ? "cursor-default text-muted2" : "cursor-pointer text-muted hover:bg-hover hover:text-text",
      ].join(" ")}
      title={locked ? tc(LOCKED_HINT_KEY) : undefined}
      onClick={locked ? undefined : onClick}
    >
      <span className="flex items-center gap-2.5">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </span>
      {!locked && shortcut && <span className="ml-4 text-[10px] text-muted2">{shortcut}</span>}
    </button>
  );
}

// A submenu entry with the key that does the same from the keyboard.
function SubMenuItem({ icon: Icon, label, shortcut, onClick, ...rest }) {
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center justify-between gap-4 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
      onClick={onClick}
      {...rest}
    >
      <span className="flex items-center gap-2.5">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </span>
      {shortcut ? <span className="text-[10px] text-muted2">{shortcut}</span> : null}
    </button>
  );
}

export default function ContextMenu({ x, y, item, assetIds, collections, activeCollectionId, editors, onAddTo, onRemoveFrom, onReveal, onShowInAllAssets, onFindSimilar, onRefreshFromDisk, onEdit, onOpenWith, onDeleteFromCatalog, onDeleteFromDisk, onCopy, onCopyPath, onCopyName, onCompare, onCollage, onAnnotate, onFlag, onAddTags, onClose }) {
  const { t } = useTranslation("nav");
  const ref = useRef(null);
  useDismiss(ref, onClose);

  // Clamp menu position to viewport
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + rect.width > window.innerWidth - 8) nx = x - rect.width;
    if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, y - rect.height);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  const manualFolders = (collections || []).filter((c) => c.kind === "manual");
  const inActiveFolder = !!activeCollectionId;

  return createPortal(
    <div
      ref={(el) => { ref.current = el; menuRef.current = el; }}
      className="fixed min-w-[200px] rounded-md border border-border/60 bg-chrome p-1 shadow-menu"
      style={{ left: `${pos.x}px`, top: `${pos.y}px`, zIndex: Z.popover }}
    >
      <MenuItem icon={Pencil} label={t("gallery.menu.edit")} shortcut={shortcutLabel("photo.edit")} onClick={() => { onEdit?.(item.image_path); onClose(); }} />
      {onFlag && (
        <MenuItem icon={Flag} label={t("gallery.menu.flag")}>
          <SubMenuItem icon={Flag} label={t("flag.pick")} shortcut={shortcutLabel("flag.pick")} data-menu-flag="pick" onClick={() => { onFlag("pick"); onClose(); }} />
          <SubMenuItem icon={FlagOff} label={t("flag.reject")} shortcut={shortcutLabel("flag.reject")} data-menu-flag="reject" onClick={() => { onFlag("reject"); onClose(); }} />
          <SubMenuItem icon={X} label={t("flag.none")} shortcut={shortcutLabel("flag.none")} data-menu-flag="none" onClick={() => { onFlag("none"); onClose(); }} />
        </MenuItem>
      )}
      {onAddTags && (
        <MenuItem icon={Tag} label={t("gallery.menu.addTags", { count: assetIds?.length || 1 })} shortcut={shortcutLabel("photo.addTags")} onClick={() => { onAddTags(); onClose(); }} />
      )}
      {onShowInAllAssets && (
        <MenuItem icon={LocateFixed} label={t("gallery.menu.showInAllAssets")} onClick={() => { onShowInAllAssets(item.asset_id); onClose(); }} />
      )}
      {onFindSimilar && (
        <MenuItem icon={ScanSearch} label={t("gallery.menu.findSimilar")} onClick={() => { onFindSimilar(item.asset_id); onClose(); }} />
      )}
      {assetIds?.length === 2 && (
        <MenuItem icon={Columns2} label={t("gallery.menu.compare")} shortcut={shortcutLabel("photo.compare")} onClick={() => { onCompare?.(assetIds); onClose(); }} />
      )}
      {assetIds?.length >= 2 && (
        <MenuItem icon={LayoutGrid} label={t("gallery.menu.collage")} onClick={() => { onCollage?.(assetIds); onClose(); }} />
      )}
      <MenuItem icon={Sparkles} label={t("gallery.menu.annotate")} locked={!api.can("annotation")}>
        <button
          type="button"
          className="flex w-full cursor-pointer rounded-md items-center gap-2.5 whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
          onClick={() => { onAnnotate?.(assetIds || [item.asset_id], { onlyMissing: true }); onClose(); }}
        >
          {t("gallery.menu.annotateSkip", { suffix: assetIds?.length > 1 ? ` ${assetIds.length}` : "" })}
        </button>
        <button
          type="button"
          className="flex w-full cursor-pointer rounded-md items-center gap-2.5 whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
          onClick={() => { onAnnotate?.(assetIds || [item.asset_id], { onlyMissing: false }); onClose(); }}
        >
          {t("gallery.menu.reannotate", { suffix: assetIds?.length > 1 ? ` ${assetIds.length}` : "" })}
        </button>
      </MenuItem>
      {editors?.length > 0 && (
        <MenuItem icon={ExternalLink} label={t("gallery.menu.openWith")}>
          {editors.map((ed) => (
            <button
              key={ed.appPath}
              type="button"
              className="flex w-full cursor-pointer rounded-md items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
              onClick={() => { onOpenWith?.(ed.appPath); onClose(); }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {ed.label}
            </button>
          ))}
        </MenuItem>
      )}
      <MenuItem icon={Eye} label={t("gallery.menu.reveal")} shortcut={shortcutLabel("photo.reveal")} locked={!api.can("fileSystem")} onClick={() => { onReveal?.(item.image_path); onClose(); }} />
      <MenuItem
        icon={RefreshCw}
        label={t("gallery.menu.refreshFromDisk", { count: assetIds?.length || 1 })}
        locked={!api.can("fileSystem")}
        onClick={() => { void onRefreshFromDisk?.(assetIds || [item.asset_id]); onClose(); }}
      />
      {/* The photos as files, like Finder's Copy: ⌘V in Finder makes copies, a chat app gets the file. */}
      <MenuItem icon={Copy} label={t("gallery.menu.copy")} shortcut={formatKeys("Mod+KeyC")} locked={!api.can("fileSystem")} onClick={() => { onCopy?.(); onClose(); }} />
      <MenuItem icon={Link2} label={t("gallery.menu.copyPath")} locked={!api.can("fileSystem")} onClick={() => { onCopyPath?.(); onClose(); }} />
      <MenuItem icon={Type} label={t("gallery.menu.copyName")} onClick={() => { onCopyName?.(); onClose(); }} />
      <MenuItem icon={Trash2} label={t("gallery.menu.delete")} shortcut={shortcutLabel("photo.delete")} onClick={() => { onDeleteFromCatalog?.(); onClose(); }} />
      <MenuItem icon={Trash} label={t("gallery.menu.deleteFromDisk")} locked={!api.can("fileSystem")} onClick={() => { onDeleteFromDisk?.(); onClose(); }} />

      {(manualFolders.length > 0 || inActiveFolder) && (
        <div className="my-1 border-t border-border/40" />
      )}

      {manualFolders.length > 0 && (
        <MenuItem icon={FolderPlus} label={t("gallery.menu.addToFolder")}>
          {manualFolders.map((col) => (
            <button
              key={col.collection_id}
              type="button"
              className="flex w-full cursor-pointer rounded-md items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
              onClick={() => { onAddTo(col.collection_id); onClose(); }}
            >
              <Folder className="h-3.5 w-3.5" />
              {col.name}
            </button>
          ))}
        </MenuItem>
      )}

      {inActiveFolder && (
        <MenuItem icon={FolderMinus} label={t("gallery.menu.removeFromFolder")} onClick={() => { onRemoveFrom(); onClose(); }} />
      )}
    </div>,
    document.body,
  );
}
