import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { asSha256Hex, type BlobStore, type HashPort, type Sha256Hex } from "@passvault/core";
import { sha256 } from "@noble/hashes/sha256";

/**
 * The app's own storage: revision bytes, the metadata database, the device key.
 *
 * All of it in `Directory.Data`, which Android keeps private to this app and
 * removes when it is uninstalled. None of it is the user's vault file — that
 * lives wherever they chose, reached through the Storage Access Framework, and
 * is the only thing here that another application is ever meant to see.
 */

const BLOBS = "blobs";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a multi-megabyte array into apply() overflows the stack.
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function readAppFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const result = await Filesystem.readFile({ path, directory: Directory.Data });
    return typeof result.data === "string" ? fromBase64(result.data) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write, then move into place.
 *
 * The same rule the desktop follows: a reader sees the whole old file or the
 * whole new one, never a half-written one. `rename` within the same directory
 * is what makes that true.
 */
export async function writeAppFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.part`;
  await Filesystem.writeFile({
    path: temporary,
    directory: Directory.Data,
    data: toBase64(bytes),
    recursive: true
  });
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch {
    // Nothing there yet, which is the ordinary case on a first write.
  }
  await Filesystem.rename({
    from: temporary,
    to: path,
    directory: Directory.Data,
    toDirectory: Directory.Data
  });
}

export async function readAppText(path: string): Promise<string | undefined> {
  try {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8
    });
    return typeof result.data === "string" ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeAppText(path: string, text: string): Promise<void> {
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    data: text,
    encoding: Encoding.UTF8,
    recursive: true
  });
}

export const webHashPort: HashPort = {
  // @noble rather than crypto.subtle: it is already in the dependency tree for
  // Ed25519, it is synchronous, and it does not care whether the WebView
  // considers itself a secure context.
  async sha256(bytes: Uint8Array): Promise<Sha256Hex> {
    return asSha256Hex(
      Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );
  }
};

/**
 * Content-addressed revision bytes, sharded exactly as on the desktop.
 *
 * Two devices holding the same revision therefore store it under the same
 * name, which is not required for correctness but makes the two platforms
 * directly comparable when something has gone wrong.
 */
export class AppBlobStore implements BlobStore {
  private pathFor(hash: Sha256Hex): string {
    return `${BLOBS}/${hash.slice(0, 2)}/${hash}.kdbx`;
  }

  public async has(hash: Sha256Hex): Promise<boolean> {
    return (await this.sizeOf(hash)) !== undefined;
  }

  public async put(bytes: Uint8Array): Promise<Sha256Hex> {
    const hash = await webHashPort.sha256(bytes);
    if (await this.has(hash)) {
      return hash;
    }
    await writeAppFileAtomic(this.pathFor(hash), bytes);
    return hash;
  }

  public async get(hash: Sha256Hex): Promise<Uint8Array> {
    const bytes = await readAppFile(this.pathFor(hash));
    if (bytes === undefined) {
      throw new Error(`no stored bytes for ${hash}`);
    }
    return bytes;
  }

  public async sizeOf(hash: Sha256Hex): Promise<number | undefined> {
    try {
      const stat = await Filesystem.stat({ path: this.pathFor(hash), directory: Directory.Data });
      return stat.size;
    } catch {
      return undefined;
    }
  }

  public async delete(hash: Sha256Hex): Promise<void> {
    try {
      await Filesystem.deleteFile({ path: this.pathFor(hash), directory: Directory.Data });
    } catch {
      // Already gone.
    }
  }
}
