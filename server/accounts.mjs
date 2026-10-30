import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const cookieName = "yohaku_session";
const lifetime = 7 * 24 * 60 * 60_000;
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16);
const sessionHash = Symbol("sessionHash");
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const safeUser = (row) =>
  row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : null;

class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function usernameValue(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().normalize("NFKC");
  return /^[\p{L}\p{N}_.-]{3,40}$/u.test(name)
    ? { name, key: name.toLowerCase() }
    : null;
}

function registrationInput(body) {
  const username = usernameValue(body?.username);
  if (!username)
    throw new AccountError(
      400,
      "用户名需为 3–40 个字母、数字、中文或 ._-，不能包含空格。",
    );
  if (
    typeof body?.password !== "string" ||
    [...body.password].length < 10 ||
    [...body.password].length > 128
  ) {
    throw new AccountError(400, "密码需为 10–128 个字符。");
  }
  return {
    username: username.name,
    usernameKey: username.key,
    password: body.password,
  };
}

async function passwordHash(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 32, passwordOptions);
  return `scrypt$32768$8$3$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function passwordMatches(password, encoded) {
  const parts = typeof encoded === "string" ? encoded.split("$") : [];
  const valid =
    parts.length === 6 &&
    parts[0] === "scrypt" &&
    parts[1] === "32768" &&
    parts[2] === "8" &&
    parts[3] === "3" &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[4]) &&
    /^[A-Za-z0-9_-]{43}$/.test(parts[5]);
  const salt = valid ? Buffer.from(parts[4], "base64url") : dummySalt;
  const expected = valid
    ? Buffer.from(parts[5], "base64url")
    : Buffer.alloc(32);
  const actual = await derive(password, salt, 32, passwordOptions);
  return timingSafeEqual(actual, expected) && valid;
}

function cookieToken(header) {
  if (typeof header !== "string") return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function sessionCookie(req, res, token) {
  const attributes = [
    `${cookieName}=${token || ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${token ? lifetime / 1000 : 0}`,
  ];
  if (req.secure) attributes.push("Secure");
  res.append("Set-Cookie", attributes.join("; "));
}

export function attachAccountRoutes({ app, database, onFirstUser = () => {} }) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
      owner_id TEXT NOT NULL REFERENCES users(id),
      issuer_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      issuer_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id);
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      issuer_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by TEXT REFERENCES users(id)
    );
  `);
  const getUser = database.prepare("SELECT * FROM users WHERE id = ?");
  const userByName = database.prepare(
    "SELECT * FROM users WHERE username_key = ?",
  );
  const userCount = database.prepare("SELECT count(*) AS count FROM users");
  const getSession =
    database.prepare(`SELECT u.*, s.created_at AS session_started_at, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id = s.owner_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const addUser = database.prepare(`INSERT INTO users
    (id, username, username_key, password_hash, is_admin, owner_id, issuer_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const addSession = database.prepare(
    "INSERT INTO sessions (token_hash, owner_id, issuer_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  );
  const attempts = new Map();

  function transaction(work) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  function limit(req, prefix, name = "", maximum = 8) {
    const now = Date.now();
    if (attempts.size > 1000)
      for (const [key, value] of attempts)
        if (value.until <= now) attempts.delete(key);
    const key = `${prefix}:${req.socket.remoteAddress || "local"}:${name}`;
    let value = attempts.get(key);
    if (!value || value.until <= now) {
      value = { count: 0, until: now + 15 * 60_000 };
      attempts.set(key, value);
    }
    if (value.count >= maximum)
      throw new AccountError(429, "尝试次数过多，请 15 分钟后再试。");
    value.count++;
    return key;
  }
  function beginSession(userId) {
    const token = randomToken(),
      now = Date.now();
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    addSession.run(hashToken(token), userId, userId, now, now + lifetime);
    return { token, loginSession: { startedAt: now, expiresAt: now + lifetime } };
  }
  function middleware(req, _res, next) {
    req.user = null;
    req.loginSession = null;
    delete req[sessionHash];
    const token = cookieToken(req.headers.cookie);
    if (token) {
      const hash = hashToken(token);
      const user = getSession.get(hash, Date.now());
      if (user) {
        req.user = safeUser(user);
        req.loginSession = { startedAt: user.session_started_at, expiresAt: user.session_expires_at };
        req[sessionHash] = hash;
      }
    }
    next();
  }
  function requireUser(req, _res, next) {
    if (!req.user)
      return next(
        Object.assign(new AccountError(401, "请先登录你的网站账户。"), {
          code: "WEBSITE_AUTH_REQUIRED",
        }),
      );
    next();
  }
  function requireAdmin(req, _res, next) {
    if (!req.user) return next(new AccountError(401, "请先登录你的网站账户。"));
    if (!req.user.isAdmin)
      return next(new AccountError(403, "只有管理员可以管理账户和邀请朋友。"));
    next();
  }

  // The caller installs Host/Origin checks and express.json() before attaching.
  app.use(middleware);
  app.get("/api/session", (req, res) =>
    res.json({ user: req.user, needsSetup: userCount.get().count === 0, loginSession: req.loginSession }),
  );

  app.post("/api/accounts/setup", async (req, res) => {
    if (userCount.get().count !== 0)
      throw new AccountError(409, "管理员账户已建立，请直接登录。");
    limit(req, "setup", "", 8);
    const input = registrationInput(req.body);
    const encoded = await passwordHash(input.password);
    const result = transaction(() => {
      if (userCount.get().count !== 0)
        throw new AccountError(409, "管理员账户已建立，请直接登录。");
      const id = randomUUID();
      addUser.run(
        id,
        input.username,
        input.usernameKey,
        encoded,
        1,
        id,
        id,
        Date.now(),
      );
      const migrated = onFirstUser(id);
      if (migrated && typeof migrated.then === "function")
        throw new AccountError(500, "首次资料迁移必须在同一事务中完成。");
      return { user: safeUser(getUser.get(id)), ...beginSession(id) };
    });
    sessionCookie(req, res, result.token);
    res.status(201).json({ user: result.user, needsSetup: false, loginSession: result.loginSession });
  });

  app.post("/api/session/login", async (req, res) => {
    const name = usernameValue(req.body?.username);
    limit(req, "login-total", "", 30);
    const key = limit(req, "login", name?.key || "invalid");
    if (
      !name ||
      typeof req.body?.password !== "string" ||
      [...req.body.password].length > 128
    )
      throw new AccountError(401, "用户名或密码不正确。");
    const user = userByName.get(name.key);
    if (!(await passwordMatches(req.body.password, user?.password_hash)))
      throw new AccountError(401, "用户名或密码不正确。");
    const result = transaction(() => {
      if (req[sessionHash])
        database
          .prepare("DELETE FROM sessions WHERE token_hash = ?")
          .run(req[sessionHash]);
      return beginSession(user.id);
    });
    attempts.delete(key);
    sessionCookie(req, res, result.token);
    res.json({ user: safeUser(user), needsSetup: false, loginSession: result.loginSession });
  });

  app.post("/api/session/logout", (req, res) => {
    if (req[sessionHash])
      database
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(req[sessionHash]);
    sessionCookie(req, res, null);
    res.status(204).end();
  });

  app.post("/api/invitations", requireAdmin, (req, res) => {
    limit(req, "invite", req.user.id, 30);
    const token = randomToken(),
      now = Date.now();
    database
      .prepare(
        `INSERT INTO invitations
      (id, token_hash, owner_id, issuer_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        hashToken(token),
        req.user.id,
        req.user.id,
        now,
        now + lifetime,
      );
    res
      .status(201)
      .json({ token, expiresAt: new Date(now + lifetime).toISOString() });
  });

  app.post("/api/accounts/register", async (req, res) => {
    limit(req, "register", "", 12);
    const input = registrationInput(req.body);
    const inviteToken = req.body?.inviteToken;
    if (
      typeof inviteToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(inviteToken)
    )
      throw new AccountError(400, "邀请码无效、已使用或已过期。");
    const inviteHash = hashToken(inviteToken);
    const validInvite = () =>
      database
        .prepare(
          `SELECT i.* FROM invitations i JOIN users u ON u.id = i.issuer_id
      WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND u.is_admin = 1`,
        )
        .get(inviteHash, Date.now());
    if (!validInvite())
      throw new AccountError(400, "邀请码无效、已使用或已过期。");
    const encoded = await passwordHash(input.password);
    const result = transaction(() => {
      const invite = validInvite();
      if (!invite) throw new AccountError(400, "邀请码无效、已使用或已过期。");
      if (userByName.get(input.usernameKey))
        throw new AccountError(409, "这个用户名已被使用，请换一个。");
      const id = randomUUID();
      addUser.run(
        id,
        input.username,
        input.usernameKey,
        encoded,
        0,
        id,
        invite.issuer_id,
        Date.now(),
      );
      database
        .prepare(
          "UPDATE invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL",
        )
        .run(Date.now(), id, invite.id);
      if (req[sessionHash])
        database
          .prepare("DELETE FROM sessions WHERE token_hash = ?")
          .run(req[sessionHash]);
      return { user: safeUser(getUser.get(id)), ...beginSession(id) };
    });
    sessionCookie(req, res, result.token);
    res.status(201).json({ user: result.user, needsSetup: false, loginSession: result.loginSession });
  });

  app.get("/api/accounts", requireAdmin, (_req, res) =>
    res.json({
      users: database
        .prepare("SELECT * FROM users ORDER BY created_at, id")
        .all()
        .map(safeUser),
    }),
  );
  return { middleware, requireUser };
}
