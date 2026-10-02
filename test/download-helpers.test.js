const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  app,
  jobs,
  isPrivateIp,
  safeFileName,
  uniqueName,
  isZipArchive,
  validateArchiveFile,
  parseContentDispositionFilename,
  isRetryableDownloadError,
  canReserveDownloadBytes,
  retryAfterMs,
  verifyFileIntegrity
} = require("../server.js");

test("Content-Disposition filename parsing supports RFC 5987 and normal filename", () => {
  assert.equal(
    parseContentDispositionFilename("attachment; filename*=UTF-8''JEI%201.12.2.jar"),
    "JEI 1.12.2.jar"
  );
  assert.equal(
    parseContentDispositionFilename('attachment; filename="appleskin.jar"'),
    "appleskin.jar"
  );
  assert.equal(
    parseContentDispositionFilename("attachment; filename=mod.jar"),
    "mod.jar"
  );
});

test("safeFileName removes unsafe path characters", () => {
  const value = safeFileName("../evil/../../mod.jar", 0);
  assert.equal(value.includes(".."), false);
  assert.equal(value.includes("/"), false);
  assert.match(value, /\.jar$/i);
});

test("uniqueName reserves collisions", () => {
  const used = new Set(["foo.jar"]);
  assert.equal(uniqueName("foo.jar", used), "foo_2.jar");
  assert.equal(uniqueName("foo.jar", used), "foo_3.jar");
});

test("ZIP/JAR signature is accepted and plain text is rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-test-"));
  try {
    const good = path.join(dir, "good.jar");
    const bad = path.join(dir, "bad.jar");
    const emptyZip = Buffer.alloc(22);
    emptyZip.set([0x50, 0x4b, 0x05, 0x06], 0);
    await fs.writeFile(good, emptyZip);
    await fs.writeFile(bad, "not a jar");
    assert.equal(await isZipArchive(good), true);
    assert.equal(await isZipArchive(bad), false);
    await validateArchiveFile(good, "good.jar");
    await assert.rejects(() => validateArchiveFile(bad, "bad.jar"), /JAR\/ZIP válido/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("private and special-use IP ranges are blocked", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.1.2.3"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("transient HTTP and network errors are retryable", () => {
  assert.equal(isRetryableDownloadError({ response: { status: 503 } }), true);
  assert.equal(isRetryableDownloadError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableDownloadError({ response: { status: 404 } }), false);
});


test("download byte reservations prevent concurrent 500 MB overflow", () => {
  assert.equal(canReserveDownloadBytes(100 * 1024 * 1024, 0, 100 * 1024 * 1024), true);
  assert.equal(canReserveDownloadBytes(200 * 1024 * 1024, 100 * 1024 * 1024, 250 * 1024 * 1024), false);
  assert.equal(canReserveDownloadBytes(0, 0, 151 * 1024 * 1024), false);
});


test("reserved/special-use addresses are blocked", () => {
  assert.equal(isPrivateIp("192.0.2.10"), true);
  assert.equal(isPrivateIp("198.51.100.20"), true);
  assert.equal(isPrivateIp("203.0.113.5"), true);
  assert.equal(isPrivateIp("224.0.0.1"), true);
  assert.equal(isPrivateIp("2001:db8::1"), true);
});


test("completed ZIP remains downloadable after a successful first download", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-download-test-"));
  const id = "test-" + Date.now();
  const zipPath = path.join(dir, "test.zip");
  const zip = Buffer.alloc(22);
  zip.set([0x50, 0x4b, 0x05, 0x06], 0);
  await fs.writeFile(zipPath, zip);
  const job = {
    tempDir: dir,
    zipPath,
    zipName: "test.zip",
    status: "done",
    created: Date.now(),
    lastAccess: Date.now(),
    downloads: 0,
    clients: new Set()
  };
  jobs.set(id, job);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const url = "http://127.0.0.1:" + port + "/api/build/" + id + "/download";
    const first = await fetch(url);
    assert.equal(first.status, 200);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    assert.equal(firstBytes.length, 22);
    const second = await fetch(url);
    assert.equal(second.status, 200);
    const secondBytes = Buffer.from(await second.arrayBuffer());
    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(jobs.has(id), true);
  } finally {
    jobs.delete(id);
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("truncated ZIP/JAR is rejected by integrity check", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-truncated-"));
  try {
    const truncated = path.join(dir, "truncated.jar");
    await fs.writeFile(truncated, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]));
    assert.equal(await isZipArchive(truncated), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("published hash mismatch is rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-hash-"));
  try {
    const file = path.join(dir, "mod.jar");
    await fs.writeFile(file, "correct content");
    const crypto = require("node:crypto");
    const good = crypto.createHash("sha1").update("correct content").digest("hex");
    await verifyFileIntegrity(file, { sha1: good }, "mod.jar");
    await assert.rejects(
      () => verifyFileIntegrity(file, { sha1: "0000000000000000000000000000000000000000" }, "mod.jar"),
      /Integridade inválida/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("download retry policy covers common transient stream errors", () => {
  assert.equal(isRetryableDownloadError({ code: "ERR_STREAM_PREMATURE_CLOSE" }), true);
  assert.equal(isRetryableDownloadError({ code: "EPIPE" }), true);
  assert.equal(isRetryableDownloadError({ response: { status: 404 } }), false);
});


test("Retry-After parser supports seconds and HTTP dates", () => {
  assert.equal(retryAfterMs({"retry-after":"2"}), 2000);
  const target = new Date(Date.now() + 1500).toUTCString();
  const parsed = retryAfterMs({"retry-after":target});
  assert.ok(parsed >= 0 && parsed <= 3000);
  assert.equal(retryAfterMs({}), 0);
});


test("client environment filter rejects server-only versions", () => {
  assert.equal(isClientCompatibleEnvironment("server_only"), false);
  assert.equal(isClientCompatibleEnvironment("dedicated_server_only"), false);
  assert.equal(isClientCompatibleEnvironment("client_and_server"), true);
  assert.equal(isClientCompatibleEnvironment("client_only"), true);
});


test("archive filenames avoid Windows reserved names and trailing dots", () => {
  assert.notEqual(safeFileName("CON.jar", 0).toUpperCase(), "CON.JAR");
  assert.equal(safeFileName("mod.jar... ", 0), "mod.jar");
  assert.match(safeFileName("thing", 0), /\.jar$/i);
  assert.match(safeFileName("lite.litemod", 0), /\.litemod$/i);
});
