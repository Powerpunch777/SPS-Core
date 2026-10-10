export function canonicalCatalogBytes(contents: Buffer): Buffer {
  if (contents.includes(0)) return contents;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
  } catch {
    return contents;
  }
}
