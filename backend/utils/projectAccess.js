function isMissingTableError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return error?.code === "42P01" || msg.includes("project_managers") && msg.includes("does not exist");
}

async function getManagerProjectIds(db, managerId) {
  const [owned, shared] = await Promise.all([
    db.from("projects").select("id").eq("created_by", managerId),
    db.from("project_managers").select("project_id").eq("manager_id", managerId).eq("status", "active")
  ]);

  if (owned.error) throw new Error(owned.error.message);
  if (shared.error && !isMissingTableError(shared.error)) throw new Error(shared.error.message);

  return Array.from(
    new Set([
      ...(owned.data || []).map((project) => project.id),
      ...(shared.error ? [] : shared.data || []).map((membership) => membership.project_id)
    ].filter(Boolean))
  );
}

async function canManageProject(db, projectId, managerId) {
  const ids = await getManagerProjectIds(db, managerId);
  return ids.includes(projectId);
}

async function requireManagerProjectAccess(db, projectId, managerId) {
  const allowed = await canManageProject(db, projectId, managerId);
  if (!allowed) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

async function ensureCreatorMembership(db, projectId, managerId) {
  const { error } = await db.from("project_managers").upsert(
    [
      {
        project_id: projectId,
        manager_id: managerId,
        role: "owner",
        status: "active",
        invited_by: managerId
      }
    ],
    { onConflict: "project_id,manager_id" }
  );
  if (error) throw new Error(error.message);
}

module.exports = {
  getManagerProjectIds,
  canManageProject,
  requireManagerProjectAccess,
  ensureCreatorMembership
};
