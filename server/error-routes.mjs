export function attachErrorRoutes({ app, errorLog, requireAdmin }) {
  // requireAdmin's own 403 text talks about accounts and invitations.
  const adminOnly = (req, res, next) => requireAdmin(req, res, (error) =>
    next(error?.status === 403 ? Object.assign(new Error("只有管理员可以查看错误记录。"), { status: 403, expose: true }) : error));
  app.get("/api/admin/errors", adminOnly, (req, res) => {
    res.json(errorLog.list({ query: req.query.query, before: req.query.before, limit: req.query.limit }));
  });
  app.get("/api/admin/errors/:code", adminOnly, (req, res, next) => {
    const entry = errorLog.get(req.params.code);
    if (!entry) return next(Object.assign(new Error("找不到这条错误记录。"), { status: 404, expose: true }));
    res.json(entry);
  });
}
