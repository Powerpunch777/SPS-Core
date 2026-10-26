import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEMP_PREFIX = "sps-native-enrollment-tls-";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NativeEnrollmentTlsValidity = { notBefore: number; notAfter: number };

export type NativeEnrollmentTlsFixture = {
  issuerCertificate: string;
  certificate: string;
  requestPem: string;
  keyPem: string;
  certPem: string;
  issuerSpkiSha256: string;
  sign: (validity: NativeEnrollmentTlsValidity) => Promise<string>;
  cleanup: () => Promise<void>;
};

function opensslDate(value: number): string {
  const date = new Date(value);
  if (!Number.isSafeInteger(value) || value % 1000 !== 0
    || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new Error("Native enrollment TLS test dates must be whole-second epoch milliseconds.");
  }
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, "") + "Z";
}

function opensslCandidates(): string[] {
  const candidates = ["openssl"];
  if (process.platform === "win32") {
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((value): value is string => Boolean(value));
    candidates.push(...programFiles.map((directory) => path.join(directory, "Git", "usr", "bin", "openssl.exe")));
  }
  return [...new Set(candidates)];
}

async function runOpenSsl(directory: string, args: string[]): Promise<void> {
  for (const executable of opensslCandidates()) {
    try {
      await execFileAsync(executable, args, {
        cwd: directory,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Unable to generate the native enrollment TLS test fixture.", { cause: error });
    }
  }
  throw new Error("OpenSSL is required to generate native enrollment TLS test fixtures.");
}

// Standard OpenSSL test material only; this is not the product issuer implementation.
export async function createNativeEnrollmentTlsFixture(
  { hostId, deviceKeyId }: { hostId: string; deviceKeyId: string },
): Promise<NativeEnrollmentTlsFixture> {
  if (!UUID_PATTERN.test(hostId) || !UUID_PATTERN.test(deviceKeyId)) {
    throw new Error("Native enrollment TLS test identities must be UUIDs.");
  }

  const tempRoot = await realpath(os.tmpdir());
  const rootIdentity = await lstat(tempRoot, { bigint: true });
  const directory = await mkdtemp(path.join(tempRoot, TEMP_PREFIX));
  const canonicalDirectory = await realpath(directory);
  const directoryIdentity = await lstat(directory, { bigint: true });
  let cleaned = false;
  let cleanupRequested = false;
  let signing = Promise.resolve();
  let cleanupPromise: Promise<void> | undefined;
  const removeDirectory = async () => {
    if (cleaned) return;
    let currentDirectory: typeof directoryIdentity;
    try {
      currentDirectory = await lstat(directory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cleaned = true;
        return;
      }
      throw error;
    }
    const currentRoot = await lstat(tempRoot, { bigint: true });
    const target = await realpath(directory);
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
      || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino
      || currentRoot.birthtimeNs !== rootIdentity.birthtimeNs
      || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink()
      || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino
      || currentDirectory.birthtimeNs !== directoryIdentity.birthtimeNs
      || target !== canonicalDirectory || path.dirname(target) !== tempRoot
      || !path.basename(target).startsWith(TEMP_PREFIX)) {
      throw new Error("Refusing to remove an unexpected native enrollment TLS test directory.");
    }
    await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    cleaned = true;
  };
  const cleanup = (): Promise<void> => {
    cleanupRequested = true;
    if (!cleanupPromise) {
      cleanupPromise = signing.then(removeDirectory).catch((error: unknown) => {
        cleanupPromise = undefined;
        throw error;
      });
    }
    return cleanupPromise;
  };

  try {
    const issuerKeyPath = path.join(directory, "issuer.key");
    const issuerPath = path.join(directory, "issuer.crt");
    const keyPath = path.join(directory, "device.key");
    const requestPath = path.join(directory, "device.csr");
    const configPath = path.join(directory, "ca.cnf");
    const serialPath = path.join(directory, "serial");
    await writeFile(configPath, [
      "[ca]",
      "default_ca=fixture_ca",
      "[fixture_ca]",
      "dir=.",
      "database=$dir/index.txt",
      "new_certs_dir=$dir",
      "certificate=$dir/issuer.crt",
      "private_key=$dir/issuer.key",
      "serial=$dir/serial",
      "default_md=sha256",
      "default_days=2",
      "policy=fixture_policy",
      "unique_subject=no",
      "copy_extensions=none",
      "x509_extensions=client_auth",
      "[fixture_policy]",
      "commonName=supplied",
      "organizationalUnitName=supplied",
      "[client_auth]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(directory, "index.txt"), "", { encoding: "utf8", mode: 0o600 });
    await runOpenSsl(directory, [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256",
      "-keyout", issuerKeyPath, "-out", issuerPath, "-days", "365",
      "-subj", `/CN=SPS Member Issuer ${hostId}`,
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-addext", "subjectKeyIdentifier=hash",
    ]);
    await runOpenSsl(directory, [
      "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256",
      "-keyout", keyPath, "-out", requestPath,
      "-subj", `/CN=SPS Member Device ${deviceKeyId}/OU=SPS Native Host ${hostId}`,
    ]);
    let serialCounter = 0;
    const sign = async ({ notBefore, notAfter }: NativeEnrollmentTlsValidity): Promise<string> => {
      if (cleanupRequested) throw new Error("Native enrollment TLS test fixture is closing.");
      const startDate = opensslDate(notBefore);
      const endDate = opensslDate(notAfter);
      if (notAfter <= notBefore || notAfter - notBefore > 90 * 24 * 60 * 60 * 1000) {
        throw new Error("Native enrollment TLS test validity must be positive and at most 90 days.");
      }
      // OpenSSL's CA database is mutable; each accepted call owns a fresh serial.
      const result = signing.then(async () => {
        const serial = (++serialCounter).toString(16).padStart(2, "0");
        const certPath = path.join(directory, `device-${serial}.crt`);
        await writeFile(serialPath, serial.length % 2 === 0 ? `${serial}\n` : `0${serial}\n`, {
          encoding: "utf8", mode: 0o600,
        });
        await runOpenSsl(directory, [
          "ca", "-batch", "-config", configPath, "-in", requestPath, "-out", certPath, "-notext",
          "-startdate", startDate, "-enddate", endDate,
        ]);
        const parsed = new X509Certificate(await readFile(certPath, "utf8"));
        if (Date.parse(parsed.validFrom) !== notBefore || Date.parse(parsed.validTo) !== notAfter) {
          throw new Error("OpenSSL did not preserve native enrollment TLS test validity.");
        }
        return parsed.raw.toString("base64url");
      });
      signing = result.then(() => undefined, () => undefined);
      return result;
    };
    const notBefore = Math.floor(Date.now() / 1000) * 1000;
    const certificate = await sign({ notBefore, notAfter: notBefore + 2 * 24 * 60 * 60 * 1000 });
    const [issuerPem, keyPem, requestPem] = await Promise.all([
      readFile(issuerPath, "utf8"),
      readFile(keyPath, "utf8"),
      readFile(requestPath, "utf8"),
    ]);
    const issuer = new X509Certificate(issuerPem);
    const certPem = new X509Certificate(Buffer.from(certificate, "base64url")).toString();
    const issuerSpki = issuer.publicKey.export({ format: "der", type: "spki" });
    return {
      issuerCertificate: issuer.raw.toString("base64url"),
      certificate,
      requestPem,
      keyPem,
      certPem,
      issuerSpkiSha256: createHash("sha256").update(issuerSpki).digest("hex"),
      sign,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
