const { httpError } = require("../utils/httpErrors");

function authorizeRoles(...roles) {
  return (req, _res, next) => {
    const role = req.auth?.user?.role;
    if (!role) return next(httpError(401, "Unauthorized"));
    if (!roles.includes(role)) return next(httpError(403, "Forbidden"));
    return next();
  };
}

module.exports = { authorizeRoles };

