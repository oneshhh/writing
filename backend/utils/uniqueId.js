function pad3(n) {
  return String(n).padStart(3, "0");
}

function buildUserUniqueId(role, seq) {
  const prefix = role === "admin" ? "ADM" : role === "manager" ? "MGR" : "WRT";
  return `${prefix}-${pad3(seq)}`;
}

function buildArticleUniqueId(projectId, seq) {
  return `ART-${projectId}-${pad3(seq)}`;
}

module.exports = { buildUserUniqueId, buildArticleUniqueId };

