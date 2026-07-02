const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ALLOWED_EXTENSIONS = ['sb3', 'sb2', 'sb'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export function isAllowedFileName(name: string): AllowedExtension | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? (ext as AllowedExtension) : null;
}

export async function readFirstBytes(file: File, count: number): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf.slice(0, count));
}

export async function isValidProjectFile(file: File): Promise<boolean> {
  const ext = isAllowedFileName(file.name);
  if (!ext) return false;
  if (ext === 'sb3') {
    const bytes = await readFirstBytes(file, 4);
    if (bytes.length < 4) return false;
    return (
      bytes[0] === ZIP_MAGIC[0] &&
      bytes[1] === ZIP_MAGIC[1] &&
      bytes[2] === ZIP_MAGIC[2] &&
      bytes[3] === ZIP_MAGIC[3]
    );
  }
  return true;
}