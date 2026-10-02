const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  isPrivateIp,
  safeFileName,
  uniqueName,
  isZipArchive,
  validateArchiveFile,
  parseContentDispositionFilename,
  isRetryableDownloadError,
  canReserveDownloadBytes
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
    await fs.writeFile(good, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
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
  assert.equal(canReserveDownloadBytes(200 * 1024 * 1024, 0, 250 * 1024 * 1024), true);
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
