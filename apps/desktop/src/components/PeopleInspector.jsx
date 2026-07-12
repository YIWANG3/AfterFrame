import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus, ImageUp, Images, LoaderCircle, Pencil, ScanFace, Trash2, UserRoundPen, UserRoundX, UsersRound, X } from "lucide-react";
import api from "../api";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";
import FaceMenu from "./FaceMenu";
import NamePersonPopover from "./NamePersonPopover";
import PersonPickerPopover from "./PersonPickerPopover";
import { confirm } from "./confirm";

// Right-hand detail panel for the people wall: who is selected, how much of
// the library they cover, and a sample of the faces the group was built from.
export default function PeopleInspector({ people, onOpenGroup, onCreateAlbum, pushToast }) {
  const { t } = useTranslation("inspector");
  const { t: navT } = useTranslation("nav");
  const { selectedGroup, groups, rename, merge, deleteGroup, load } = people;
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMoreFaces, setLoadingMoreFaces] = useState(false);
  const [naming, setNaming] = useState(null); // anchorRect
  const [albumBusy, setAlbumBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selectedFaces, setSelectedFaces] = useState(() => new Set());
  const [faceMenu, setFaceMenu] = useState(null); // { faceIds, x, y, anchorRect }
  const [picking, setPicking] = useState(null); // { faceIds, anchorRect }

  const groupId = selectedGroup?.group_id || null;
  const namedGroups = useMemo(() => groups.filter((group) => group.name?.trim()), [groups]);

  function toggleFace(faceId) {
    setSelectedFaces((current) => {
      const next = new Set(current);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  }

  async function applyCorrection(action, successTitle) {
    try {
      await action();
      pushToast?.({ title: successTitle, ttl: 3500 });
      setSelectedFaces(new Set());
      await load();
    } catch (error) {
      pushToast?.({ title: t("people.correctionFailed"), message: error?.message || String(error), ttl: 6000, tone: "error" });
    }
  }

  function removeFaces(faceIds) {
    void applyCorrection(
      () => api.removeFaceFromPerson({ faceIds }),
      t("peoplePanel.removedCount", { count: faceIds.length }),
    );
  }

  async function setCoverFace(faceId) {
    try {
      await api.setPeopleGroupCover({ groupId, faceId });
      setDetail((current) => (current ? { ...current, cover_face_id: faceId } : current));
      pushToast?.({ title: t("people.coverUpdated"), ttl: 3500 });
      await load();
    } catch (error) {
      pushToast?.({ title: t("people.coverFailed"), message: error?.message || String(error), ttl: 6000, tone: "error" });
    }
  }

  async function confirmDeleteGroup() {
    const approved = await confirm({
      title: navT("people.deleteConfirmTitle", { name: selectedGroup.name || navT("people.unnamed") }),
      message: navT("people.deleteConfirmMessage"),
      detail: navT("people.deleteConfirmDetail"),
      confirmLabel: navT("people.deleteConfirmAction"),
      cancelLabel: navT("people.deleteCancel"),
      danger: true,
    });
    if (!approved) return;
    setDeleteBusy(true);
    try {
      await deleteGroup(selectedGroup.group_id);
    } catch { /* usePeopleGroups already surfaced the error */ }
    finally { setDeleteBusy(false); }
  }

  // The detail endpoint pages faces by confidence; append the next page so
  // every member of a large group is reachable for inspection and correction.
  async function loadMoreFaces() {
    if (!detail || loadingMoreFaces) return;
    setLoadingMoreFaces(true);
    try {
      const next = await api.peopleGroupDetail({ groupId, faceOffset: detail.faces.length });
      if (next?.faces) {
        setDetail((current) => (current ? { ...next, faces: [...current.faces, ...next.faces] } : next));
      }
    } catch (error) {
      console.warn("[PeopleInspector] load more faces failed", error);
    } finally {
      setLoadingMoreFaces(false);
    }
  }

  useEffect(() => {
    setDetail(null);
    setNaming(null);
    setSelectedFaces(new Set());
    setFaceMenu(null);
    setPicking(null);
    if (!groupId) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const payload = await api.peopleGroupDetail({ groupId });
        if (!cancelled) setDetail(payload);
      } catch (error) {
        console.warn("[PeopleInspector] detail failed", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [groupId, selectedGroup?.face_count, selectedGroup?.name]);

  if (!selectedGroup) {
    return (
      <aside className="flex h-full items-center justify-center overflow-y-auto border-l border-border/40 bg-chrome px-6">
        <div className="text-center text-muted2">
          <UsersRound className="mx-auto h-7 w-7 stroke-[1.25]" />
          <div className="mt-3 text-[12px] leading-5">{t("peoplePanel.empty")}</div>
        </div>
      </aside>
    );
  }

  const named = !!selectedGroup.name?.trim();
  const cover = selectedGroup.cover_preview_path || selectedGroup.cover_image_path;

  return (
    <aside className="flex h-full flex-col overflow-hidden border-l border-border/40 bg-chrome">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="flex flex-col items-center">
          <FaceCrop
            src={localFileUrl(cover)}
            bbox={selectedGroup.cover_bbox}
            alt=""
            className="h-[132px] w-[132px] rounded-2xl border border-border/50 shadow-sm"
          />
          <button
            type="button"
            onClick={(e) => setNaming(e.currentTarget.getBoundingClientRect())}
            title={named ? t("peoplePanel.rename") : t("people.addName")}
            className={[
              "mt-3 flex max-w-full items-center gap-1.5 truncate rounded-md px-2 py-1 transition hover:bg-hover",
              named ? "text-[14px] font-semibold text-text" : "text-[12px] text-muted2 hover:text-text",
            ].join(" ")}
          >
            {named ? selectedGroup.name : t("people.addName")}
            <Pencil className="h-3 w-3 shrink-0 text-muted2" />
          </button>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-muted2">
            <span className="flex items-center gap-1">
              <ScanFace className="h-3 w-3" />
              {t("peoplePanel.faces", { count: Number(detail?.face_count ?? selectedGroup.face_count) || 0 })}
            </span>
            <span className="flex items-center gap-1">
              <Images className="h-3 w-3" />
              {t("peoplePanel.photos", { count: Number(detail?.photo_count) || 0 })}
            </span>
          </div>

          <div className="mt-4 flex w-full flex-col gap-2">
            <button
              type="button"
              onClick={() => onOpenGroup(selectedGroup)}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-app transition hover:bg-accent/90"
            >
              <Images className="h-3.5 w-3.5" />
              {t("peoplePanel.viewPhotos")}
            </button>
            <button
              type="button"
              disabled={albumBusy}
              onClick={() => {
                setAlbumBusy(true);
                Promise.resolve(onCreateAlbum?.(selectedGroup)).finally(() => setAlbumBusy(false));
              }}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border/65 px-3 text-[12px] text-muted transition hover:bg-hover hover:text-text disabled:cursor-wait disabled:opacity-55"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              {t("peoplePanel.createAlbum")}
            </button>
            <button
              type="button"
              disabled={deleteBusy}
              onClick={() => void confirmDeleteGroup()}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-red-500/25 px-3 text-[12px] text-red-400 transition hover:border-red-500/40 hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-55"
            >
              {deleteBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {navT("people.deleteGroup")}
            </button>
          </div>
        </div>

        <div className="mt-6 border-t border-border/40 pt-4">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">
              {t("peoplePanel.sampleFaces")}
            </div>
            {selectedFaces.size > 0 && (
              <span className="text-[10px] text-muted2">{t("peoplePanel.selectedCount", { count: selectedFaces.size })}</span>
            )}
          </div>
          <p className="mt-1 text-[10px] leading-4 text-muted2">{t("peoplePanel.correctionHint")}</p>
          {loading ? (
            <div className="flex min-h-24 items-center justify-center text-muted2">
              <LoaderCircle className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <div className="mt-2.5 grid grid-cols-4 gap-1.5">
              {(detail?.faces || []).map((face) => {
                const selected = selectedFaces.has(face.face_id);
                return (
                  <button
                    key={face.face_id}
                    data-face-id={face.face_id}
                    type="button"
                    onClick={() => toggleFace(face.face_id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const faceIds = selected && selectedFaces.size > 0
                        ? [...selectedFaces]
                        : [face.face_id];
                      setFaceMenu({
                        faceIds,
                        anchorFaceId: face.face_id,
                        x: e.clientX,
                        y: e.clientY,
                        anchorRect: e.currentTarget.getBoundingClientRect(),
                      });
                    }}
                    className={[
                      "relative overflow-hidden rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                      selected ? "ring-2 ring-accent/85" : "",
                    ].join(" ")}
                  >
                    <FaceCrop
                      src={localFileUrl(face.preview_path || face.image_path)}
                      bbox={face.bounding_box}
                      alt=""
                      className="aspect-square w-full rounded-lg border border-border/40"
                    />
                    {selected && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-app">✓</span>
                    )}
                    {detail?.cover_face_id === face.face_id && (
                      <span className="absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-app shadow-sm" title={t("people.coverCurrent")}>
                        <ImageUp className="h-2.5 w-2.5 stroke-[2.2]" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {!loading && detail && detail.faces.length < Number(detail.face_count) && (
            <button
              type="button"
              disabled={loadingMoreFaces}
              onClick={() => void loadMoreFaces()}
              className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/60 text-[11px] text-muted transition hover:bg-hover hover:text-text disabled:cursor-wait disabled:opacity-55"
            >
              {loadingMoreFaces
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                : t("peoplePanel.showMoreFaces", { count: Number(detail.face_count) - detail.faces.length })}
            </button>
          )}
        </div>
      </div>

      {/* Batch action bar for the current face selection. */}
      {selectedFaces.size > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border/50 bg-chrome px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
            {t("peoplePanel.selectedCount", { count: selectedFaces.size })}
          </span>
          <button
            type="button"
            title={t("people.reassign")}
            onClick={(e) => setPicking({ faceIds: [...selectedFaces], anchorRect: e.currentTarget.getBoundingClientRect() })}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border/65 px-2 text-[11px] text-muted transition hover:bg-hover hover:text-text"
          >
            <UserRoundPen className="h-3.5 w-3.5" />
            {t("peoplePanel.reassignShort")}
          </button>
          <button
            type="button"
            title={t("people.removeFromGroup")}
            onClick={() => removeFaces([...selectedFaces])}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border/65 px-2 text-[11px] text-muted transition hover:bg-hover hover:text-text"
          >
            <UserRoundX className="h-3.5 w-3.5" />
            {t("peoplePanel.removeShort")}
          </button>
          <button
            type="button"
            title={t("peoplePanel.clearSelection")}
            onClick={() => setSelectedFaces(new Set())}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted2 transition hover:bg-hover hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {faceMenu && (
        <FaceMenu
          position={faceMenu}
          onClose={() => setFaceMenu(null)}
          items={[
            {
              key: "set-cover",
              icon: ImageUp,
              label: detail?.cover_face_id === faceMenu.anchorFaceId
                ? t("people.coverCurrent")
                : t("people.setCover"),
              onClick: () => void setCoverFace(faceMenu.anchorFaceId),
            },
            {
              key: "reassign",
              icon: UserRoundPen,
              label: t("people.reassign"),
              onClick: () => setPicking({ faceIds: faceMenu.faceIds, anchorRect: faceMenu.anchorRect }),
            },
            {
              key: "remove",
              icon: UserRoundX,
              label: named
                ? t("people.removeFrom", { name: selectedGroup.name })
                : t("people.removeFromGroup"),
              onClick: () => removeFaces(faceMenu.faceIds),
            },
          ]}
        />
      )}

      {picking && (
        <PersonPickerPopover
          anchorRect={picking.anchorRect}
          excludeGroupId={groupId}
          onClose={() => setPicking(null)}
          onPick={(target) => void applyCorrection(
            () => api.assignFaceToPerson({ faceIds: picking.faceIds, groupId: target.group_id }),
            t("people.reassigned", { name: target.name }),
          )}
        />
      )}

      {naming && (
        <NamePersonPopover
          anchorRect={naming}
          group={selectedGroup}
          namedGroups={namedGroups}
          onClose={() => setNaming(null)}
          onRename={(name) => rename(selectedGroup.group_id, name)}
          onMerge={(target) => merge(selectedGroup.group_id, target.group_id)}
        />
      )}
    </aside>
  );
}
