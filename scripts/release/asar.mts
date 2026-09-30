// A minimal read-only reader for Electron's asar archive format, enough for
// the release checks (header, file list, file contents, unpacked flags and
// integrity hashes). Format: a Chromium "pickle" holding the header size,
// then a pickle holding the JSON header, then the concatenated file data.
import { closeSync, openSync, readSync } from 'node:fs';

export interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
  integrity?: { algorithm: string; hash: string };
}

export interface AsarArchive {
  /** Every file path (not directories), with `/` separators, no leading `/`. */
  files(): string[];
  entry(file: string): AsarEntry | undefined;
  /** A packed file's bytes; null when absent or unpacked. */
  read(file: string): Buffer | null;
  readText(file: string): string | null;
}

export function openAsar(archivePath: string): AsarArchive {
  const fd = openSync(archivePath, 'r');
  let header: AsarEntry;
  let dataOffset: number;
  try {
    const sizeBuffer = Buffer.alloc(8);
    readSync(fd, sizeBuffer, 0, 8, 0);
    const headerPickleSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerPickleSize);
    readSync(fd, headerBuffer, 0, headerPickleSize, 8);
    const jsonLength = headerBuffer.readUInt32LE(4);
    header = JSON.parse(
      headerBuffer.toString('utf8', 8, 8 + jsonLength),
    ) as AsarEntry;
    dataOffset = 8 + headerPickleSize;
  } finally {
    closeSync(fd);
  }

  const entry = (file: string): AsarEntry | undefined => {
    let node: AsarEntry | undefined = header;
    for (const part of file.split('/').filter(Boolean)) {
      node = node?.files?.[part];
      if (!node) return undefined;
    }
    return node;
  };

  const read = (file: string): Buffer | null => {
    const node = entry(file);
    if (!node || node.files || node.unpacked || node.offset === undefined) {
      return null;
    }
    const size = node.size ?? 0;
    const buffer = Buffer.alloc(size);
    const handle = openSync(archivePath, 'r');
    try {
      readSync(handle, buffer, 0, size, dataOffset + Number(node.offset));
    } finally {
      closeSync(handle);
    }
    return buffer;
  };

  return {
    files() {
      const out: string[] = [];
      const walk = (node: AsarEntry, prefix: string) => {
        for (const [name, child] of Object.entries(node.files ?? {})) {
          const full = prefix ? `${prefix}/${name}` : name;
          if (child.files) walk(child, full);
          else out.push(full);
        }
      };
      walk(header, '');
      return out.sort();
    },
    entry,
    read,
    readText(file) {
      return read(file)?.toString('utf8') ?? null;
    },
  };
}
