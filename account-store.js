const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.MIKAEL_DATA_DIR || (fs.existsSync("/var/data") ? "/var/data/mikael-modpack-builder" : path.join(__dirname, "data"));
const DB_FILE = path.join(DATA_DIR, "accounts.json");
const SESSION_DAYS = 30;

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { await fsp.access(DB_FILE); }
  catch { await atomicWrite({ users: [], sessions: {}, projects: [] }); }
}

async function readDb() {
  await ensureStore();
  try { return JSON.parse(await fsp.readFile(DB_FILE, "utf8")); }
  catch { return { users: [], sessions: {}, projects: [] }; }
}

async function atomicWrite(db) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tmp, DB_FILE);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}
function validUsername(value) {
  return /^[A-Za-z0-9_]{3,24}$/.test(String(value || "").trim());
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}
function verifyPassword(password, user) {
  const actual = Buffer.from(hashPassword(password, user.salt).hash, "hex");
  const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function sessionHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createUser(username, password) {
  const name = String(username || "").trim();
  if (!validUsername(name)) throw new Error("Nome inválido. Use 3–24 caracteres: letras, números ou _.");
  if (String(password || "").length < 6) throw new Error("A senha precisa ter pelo menos 6 caracteres.");
  const db = await readDb();
  const key = normalizeUsername(name);
  if (db.users.some(u => u.usernameKey === key)) throw new Error("Esse nome já está em uso.");
  const { salt, hash } = hashPassword(password);
  const user = { id: crypto.randomUUID(), username: name, usernameKey: key, salt, passwordHash: hash, createdAt: new Date().toISOString() };
  db.users.push(user);
  await atomicWrite(db);
  return { id: user.id, username: user.username };
}

async function login(username, password) {
  const db = await readDb();
  const user = db.users.find(u => u.usernameKey === normalizeUsername(username));
  if (!user || !verifyPassword(password, user)) throw new Error("Nome ou senha incorretos.");
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[sessionHash(token)] = { userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 86400000 };
  await atomicWrite(db);
  return { token, user: { id: user.id, username: user.username } };
}

async function getUserByToken(token) {
  if (!token) return null;
  const db = await readDb();
  const key = sessionHash(token);
  const session = db.sessions[key];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete db.sessions[key];
    await atomicWrite(db);
    return null;
  }
  const user = db.users.find(u => u.id === session.userId);
  return user ? { id: user.id, username: user.username } : null;
}

async function logout(token) {
  if (!token) return;
  const db = await readDb();
  delete db.sessions[sessionHash(token)];
  await atomicWrite(db);
}

async function listProjects(userId) {
  const db = await readDb();
  return db.projects.filter(p => p.userId === userId).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function saveProject(userId, project) {
  const name = String(project.name || "").trim();
  if (!name || name.length > 80) throw new Error("Dê ao modpack um nome entre 1 e 80 caracteres.");
  const db = await readDb();
  let item = project.id ? db.projects.find(p => p.id === project.id && p.userId === userId) : null;
  const now = new Date().toISOString();
  if (item) {
    Object.assign(item, { name, minecraft: String(project.minecraft || ""), loader: String(project.loader || ""), loaderVersion: String(project.loaderVersion || ""), links: Array.isArray(project.links) ? project.links.slice(0, 999999) : [], updatedAt: now });
  } else {
    item = { id: crypto.randomUUID(), userId, name, minecraft: String(project.minecraft || ""), loader: String(project.loader || ""), loaderVersion: String(project.loaderVersion || ""), links: Array.isArray(project.links) ? project.links.slice(0, 999999) : [], createdAt: now, updatedAt: now };
    db.projects.push(item);
  }
  await atomicWrite(db);
  return { ...item, userId: undefined };
}

async function getProject(userId, id) {
  const db = await readDb();
  const p = db.projects.find(x => x.id === id && x.userId === userId);
  return p ? { ...p, userId: undefined } : null;
}

async function deleteProject(userId, id) {
  const db = await readDb();
  const before = db.projects.length;
  db.projects = db.projects.filter(x => !(x.id === id && x.userId === userId));
  if (db.projects.length === before) return false;
  await atomicWrite(db);
  return true;
}

module.exports = { ensureStore, createUser, login, getUserByToken, logout, listProjects, saveProject, getProject, deleteProject };