import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEMP_PREFIX = "sps-member-tls-";

export type MemberTlsPurpose = "clientAuth" | "serverAuth";

export type MemberTlsFixture = {
  certPem: string;
  keyPem: string;
  certificate: string;
  certificateSha256: string;
  spkiSha256: string;
  cleanup: () => Promise<void>;
};

function opensslCandidates(): string[] {
  const candidates = ["openssl"];
  if (process.platform === "win32") {
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((value): value is string => Boolean(value));
    candidates.push(...programFiles.map((directory) => path.join(directory, "Git", "usr", "bin", "openssl.exe")));
  }
  return [...new Set(candidates)];
}

async function generateCertificate(directory: string, purpose: MemberTlsPurpose): Promise<void> {
  const keyPath = path.join(directory, "member.key");
  const certificatePath = path.join(directory, "member.crt");
  const args = [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certificatePath,
    "-days", "2",
    "-subj", "/CN=SPS Member TLS Test",
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
    "-addext", `extendedKeyUsage=${purpose}`,
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
  ];

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
      throw new Error("Unable to generate the member TLS test certificate.", { cause: error });
    }
  }

  throw new Error("OpenSSL is required to generate member TLS test certificates.");
}

export async function createMemberTlsFixture(
  { purpose = "clientAuth" }: { purpose?: MemberTlsPurpose } = {},
): Promise<MemberTlsFixture> {
  const tempRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, TEMP_PREFIX));
  const canonicalDirectory = await realpath(directory);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    let originalStat: Awaited<ReturnType<typeof lstat>>;
    try {
      originalStat = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cleaned = true;
        return;
      }
      throw error;
    }
    if (!originalStat.isDirectory() || originalStat.isSymbolicLink()) {
      throw new Error("Refusing to remove an unexpected member TLS test directory.");
    }
    let target: string;
    try {
      target = await realpath(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cleaned = true;
        return;
      }
      throw error;
    }
    if (target !== canonicalDirectory
      || path.dirname(target) !== tempRoot
      || !path.basename(target).startsWith(TEMP_PREFIX)) {
      throw new Error("Refusing to remove an unexpected member TLS test directory.");
    }
    await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    cleaned = true;
  };

  try {
    await generateCertificate(directory, purpose);
    const [certPem, keyPem] = await Promise.all([
      readFile(path.join(directory, "member.crt"), "utf8"),
      readFile(path.join(directory, "member.key"), "utf8"),
    ]);
    const parsed = new X509Certificate(certPem);
    const der = parsed.raw;
    const spki = parsed.publicKey.export({ format: "der", type: "spki" });
    return {
      certPem,
      keyPem,
      certificate: der.toString("base64url"),
      certificateSha256: createHash("sha256").update(der).digest("hex"),
      spkiSha256: createHash("sha256").update(spki).digest("hex"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
