export function attachErrorRoutes({ app, errorLog, requireAdmin }) {
  app.get("/api/admin/errors", requireAdmin, (req, res) => {
    res.json(errorLog.list({ query: req.query.query, before: req.query.before, limit: req.query.limit }));
  });
  app.get("/api/admin/errors/:code", requireAdmin, (req, res, next) => {
    const entry = errorLog.get(req.params.code);
    if (!entry) return next(Object.assign(new Error("找不到这条错误记录。"), { status: 404, expose: true }));
    res.json(entry);
  });
}
