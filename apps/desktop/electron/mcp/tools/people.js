// People (face groups), pets (cat and dog groups) and the offline recognizer.
// Shape and ctx: see tools/index.js.

module.exports = (ctx) => {
  const { deps, commands, requireCatalog } = ctx;
  return [
    {
      name: "list_people",
      description:
        "Recognized people and pets in the catalog: groups of one person's faces, or of one cat's or dog's " +
        "photos. Each has an id, subject (person / cat / dog), name (if the user named it), face count, state " +
        "(candidate/confirmed/ignored) and cover thumbnail. Use the group id with search_assets person_id to " +
        "find someone's photos, or with get_person / update_person.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["candidate", "confirmed", "ignored"], description: "Filter by state; default all non-ignored" },
          subject: { type: "string", enum: ["person", "pet", "cat", "dog"], description: "Only people, only pets (cats and dogs), only cats or only dogs; default all" },
        },
      },
      async handler(args) {
        requireCatalog();
        const all = await commands.listPeopleGroups({ state: args.state });
        const wanted = args.subject === "pet" ? ["cat", "dog"] : args.subject ? [args.subject] : null;
        const groups = wanted ? all.filter((group) => wanted.includes(group.subject || "person")) : all;
        return { count: groups.length, people: groups };
      },
    },
    {
      name: "get_person",
      description:
        "Detail for one people group: name, state, faces (paginated — each face has its asset_id), and " +
        "optionally similar groups that might be the same person (merge candidates for update_person).",
      inputSchema: {
        type: "object",
        properties: {
          person_id: { type: "string" },
          face_limit: { type: "number", description: "Max faces to return, default 24" },
          face_offset: { type: "number" },
          include_similar: { type: "boolean", description: "Also return likely-same-person groups" },
        },
        required: ["person_id"],
      },
      async handler(args) {
        requireCatalog();
        const groupId = String(args.person_id);
        const [detail, similar] = await Promise.all([
          commands.peopleGroupDetail({ groupId, faceLimit: args.face_limit || 24, faceOffset: args.face_offset || 0 }),
          args.include_similar ? commands.similarPeopleGroups({ groupId }).catch(() => []) : null,
        ]);
        return { ...detail, similar: similar || undefined };
      },
    },
    {
      name: "update_person",
      description:
        "Edit a people group. Actions: 'rename' (name); 'set_cover' (face_id); 'set_state' " +
        "(state: confirmed accepts the person, ignored hides the group and a rescan will NOT restore it — " +
        "confirm with the user first); 'merge' (merge this group INTO target_person_id); " +
        "'assign_faces' / 'remove_faces' (face_ids — move faces into this group / detach them).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["rename", "set_cover", "set_state", "merge", "assign_faces", "remove_faces"] },
          person_id: { type: "string" },
          name: { type: "string", description: "For rename" },
          face_id: { type: "string", description: "For set_cover" },
          face_ids: { type: "array", items: { type: "string" }, description: "For assign_faces/remove_faces" },
          state: { type: "string", enum: ["candidate", "confirmed", "ignored"], description: "For set_state" },
          target_person_id: { type: "string", description: "For merge: the group that survives" },
        },
        required: ["action", "person_id"],
      },
      async handler(args) {
        requireCatalog();
        const groupId = String(args.person_id);
        let result;
        if (args.action === "rename") {
          if (!args.name) throw new Error("name is required for rename.");
          result = await commands.renamePeopleGroup({ groupId, name: String(args.name) });
        } else if (args.action === "set_cover") {
          if (!args.face_id) throw new Error("face_id is required for set_cover.");
          result = await commands.setPeopleGroupCover({ groupId, faceId: String(args.face_id) });
        } else if (args.action === "set_state") {
          if (!args.state) throw new Error("state is required for set_state.");
          result = await commands.setPeopleGroupState({ groupId, state: String(args.state) });
        } else if (args.action === "merge") {
          if (!args.target_person_id) throw new Error("target_person_id is required for merge.");
          result = await commands.mergePeopleGroups({ sourceGroupId: groupId, targetGroupId: String(args.target_person_id) });
        } else if (args.action === "assign_faces") {
          const faceIds = (args.face_ids || []).map(String).filter(Boolean);
          if (!faceIds.length) throw new Error("face_ids is required for assign_faces.");
          result = await commands.assignFaceToPerson({ faceIds, groupId });
        } else if (args.action === "remove_faces") {
          const faceIds = (args.face_ids || []).map(String).filter(Boolean);
          if (!faceIds.length) throw new Error("face_ids is required for remove_faces.");
          result = await commands.removeFaceFromPerson({ faceIds });
        } else {
          throw new Error(`Unknown action: ${args.action}`);
        }
        deps.broadcastCatalogChanged?.("people");
        return result;
      },
    },
    {
      name: "index_people",
      description:
        "Run face recognition over the library (or specific assets) using the app's local Core ML model, " +
        "and pet recognition (cats and dogs) in the same pass while the user has it on (the default). " +
        "Fully offline. Long-running: returns a job_id — poll get_job_status. Fails with guidance when no " +
        "face model is installed (the user sets one up in Settings → People & Pets).",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" }, description: "Limit to these assets; default whole catalog" },
          include_pets: { type: "boolean", description: "false leaves pets out of this run; default follows the user's setting (it can't turn pets on when the user turned them off)" },
        },
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startPeopleIndex) throw new Error("People indexing bridge unavailable.");
        const status = await deps.startPeopleIndex({
          assetIds: (args.asset_ids || []).map(String).filter(Boolean),
          ...(args.include_pets === false ? { pets: false } : {}),
        });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "people_index" });
        return {
          job_id: status.jobId,
          status: status.status,
          note: "Recognition runs in the background — poll get_job_status. People and pets appear in the app's People & Pets view as they are found.",
        };
      },
    },
  ];
};
