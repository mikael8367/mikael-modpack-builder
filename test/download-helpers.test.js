const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const archiver = require("archiver");

const {
  app,
  parseCurseForgeFileId,
  isReleasedCurseForgeFile,
  MAX_UPLOAD_BODY_BYTES,
  jobs,
  uploads,
  isPrivateIp,
  safeFileName,
  uniqueName,
  isZipArchive,
  validateArchiveFile,
  parseContentDispositionFilename,
  isRetryableDownloadError,
  canReserveDownloadBytes,
  retryAfterMs,
  isClientCompatibleEnvironment,
  isKnownModrinthLoader,
  redactUrl,
  normalizeDuplicateUrl,
  curseForgeCdnArtifactKey,
  strongPublishedHash,
  fileSha256,
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
    await new Promise((resolve, reject) => {
      const output = require("node:fs").createWriteStream(good);
      const archive = archiver("zip", { store: true });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append("valid mod placeholder", { name: "test.txt" });
      archive.finalize();
    });
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


test("manifest URL redaction removes query tokens", () => {
  assert.equal(redactUrl("https://example.com/mod.jar?token=secret&utm_source=x"), "https://example.com/mod.jar");
  assert.equal(redactUrl("not-a-url").length <= 500, true);
});


test("LiteLoader file extension is preserved", () => {
  assert.equal(safeFileName("example.litemod", 0), "example.litemod");
});


test("empty ZIP archive is rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-emptyzip-"));
  try {
    const emptyZip = path.join(dir, "empty.zip");
    const buf = Buffer.alloc(22);
    buf.set([0x50, 0x4b, 0x05, 0x06], 0);
    await fs.writeFile(emptyZip, buf);
    assert.equal(await isZipArchive(emptyZip), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("empty ZIP is not considered a usable mod archive", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-empty-"));
  try {
    const file = path.join(dir, "empty.zip");
    const buf = Buffer.alloc(22);
    buf.set([0x50, 0x4b, 0x05, 0x06], 0);
    await fs.writeFile(file, buf);
    assert.equal(await isZipArchive(file), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("upload body guard constant leaves multipart overhead room", () => {
  assert.ok(MAX_UPLOAD_BODY_BYTES >= 500 * 1024 * 1024);
  assert.ok(MAX_UPLOAD_BODY_BYTES < 520 * 1024 * 1024);
});


test("CurseForge file ID parser accepts files and download paths", () => {
  assert.equal(parseCurseForgeFileId(["minecraft","mc-mods","jei","files","123456"]), 123456);
  assert.equal(parseCurseForgeFileId(["minecraft","mc-mods","jei","download","123456"]), 123456);
  assert.equal(parseCurseForgeFileId(["minecraft","mc-mods","jei","files","abc"]), null);
});


test("CurseForge file status filter accepts only released non-server files", () => {
  assert.equal(isReleasedCurseForgeFile({ isAvailable: true, fileStatus: 10, isServerPack: false }), true);
  assert.equal(isReleasedCurseForgeFile({ isAvailable: true, fileStatus: 9, isServerPack: false }), false);
  assert.equal(isReleasedCurseForgeFile({ isAvailable: true, fileStatus: 10, isServerPack: true }), false);
  assert.equal(isReleasedCurseForgeFile({ isAvailable: false, fileStatus: 10, isServerPack: false }), false);
});


test("unknown Modrinth loaders are not treated as compatible project loaders", () => {
  assert.equal(isKnownModrinthLoader("Forge"), true);
  assert.equal(isKnownModrinthLoader("Fabric"), true);
  assert.equal(isKnownModrinthLoader("Outro"), false);
  assert.equal(isKnownModrinthLoader(""), false);
});


test("full local build pipeline creates a downloadable ZIP", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-full-build-"));
  const source = path.join(dir, "Example Mod.jar");
  const zipPath = path.join(dir, "source.zip");
  const output = require("node:fs").createWriteStream(source);
  await new Promise((resolve, reject) => {
    const archive = archiver("zip", { store: true });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append("hello", { name: "example.txt" });
    archive.finalize();
  });
  const uploadDir = path.join(dir, "uploaded");
  await fs.mkdir(uploadDir);
  const uploadedFile = path.join(uploadDir, "Example Mod.jar");
  await fs.copyFile(source, uploadedFile);
  const uploadId = "test-upload-" + Date.now();
  uploads.set(uploadId, {
    dir: uploadDir,
    files: [{ filename: "Example Mod.jar", path: uploadedFile }],
    created: Date.now(),
    lastAccess: Date.now(),
    inUse: 0
  });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch("http://127.0.0.1:" + port + "/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minecraftVersion: "1.12.2", modLoader: "Forge", links: [], uploadId })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.id);
    let status;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const sr = await fetch("http://127.0.0.1:" + port + "/api/build/" + encodeURIComponent(body.id) + "/status");
      status = await sr.json();
      if (status.status === "done" || status.status === "error") break;
    }
    assert.equal(status.status, "done", status.progress?.message || "build did not finish");
    assert.ok(status.downloadUrl);
    const download = await fetch("http://127.0.0.1:" + port + status.downloadUrl);
    assert.equal(download.status, 200);
    const data = Buffer.from(await download.arrayBuffer());
    assert.ok(data.length > 100);
    await new Promise((resolve, reject) => {
      const p = path.join(dir, "downloaded.zip");
      require("node:fs").writeFile(p, data, err => err ? reject(err) : resolve());
    });
    assert.equal(await isZipArchive(path.join(dir, "downloaded.zip")), true);
  } finally {
    const buildIds = [...jobs.keys()].filter(id => jobs.get(id)?.tempDir && String(jobs.get(id).tempDir).startsWith(os.tmpdir()));
    for (const id of buildIds) {
      const job = jobs.get(id);
      if (job && job.status !== "running" && job.status !== "zipping") {
        jobs.delete(id);
        await fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    uploads.delete(uploadId);
    await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("strict URL dedupe canonicalizes equivalent URLs", () => {
  assert.equal(
    normalizeDuplicateUrl("HTTPS://Example.COM:443/mod.jar?b=2&a=1#fragment"),
    normalizeDuplicateUrl("https://example.com/mod.jar?a=1&b=2")
  );
  assert.notEqual(
    normalizeDuplicateUrl("https://example.com/mod.jar?token=A"),
    normalizeDuplicateUrl("https://example.com/mod.jar?token=B")
  );
});

test("CurseForge CDN artifact IDs are stable across CDN mirrors", () => {
  assert.equal(curseForgeCdnArtifactKey("https://edge.forgecdn.net/files/2782/568/SomeMod.jar"), "curseforge:file:2782568");
  assert.equal(curseForgeCdnArtifactKey("https://mediafilez.forgecdn.net/files/2782/568/SomeMod.jar"), "curseforge:file:2782568");
});

test("published hashes choose the strongest available identity", () => {
  assert.equal(strongPublishedHash({ md5: "AA", sha1: "BB", sha512: "CC" }), "cc");
  assert.equal(strongPublishedHash([{ algo: 1, value: "DD" }, { algo: 2, value: "EE" }]), "dd");
});

test("SHA-256 detects byte-identical files even with different filenames", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mikael-dedupe-hash-"));
  try {
    const first = path.join(dir, "first.jar");
    const second = path.join(dir, "second.jar");
    await fs.writeFile(first, Buffer.from("same mod bytes"));
    await fs.writeFile(second, Buffer.from("same mod bytes"));
    assert.equal(await fileSha256(first), await fileSha256(second));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
