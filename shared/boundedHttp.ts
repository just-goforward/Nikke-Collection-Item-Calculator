export async function readBoundedBytes(
  message: Request | Response,
  maxBytes: number,
  errorCode: string,
): Promise<Uint8Array> {
  const declaredHeader = message.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      throw new Error(errorCode);
    }
  }

  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(errorCode);
        throw new Error(errorCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(
  message: Request | Response,
  maxBytes: number,
  errorCode: string,
) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedBytes(message, maxBytes, errorCode),
  );
}

export async function readBoundedJson(
  message: Request | Response,
  maxBytes: number,
  errorCode: string,
): Promise<unknown> {
  let text: string;
  try {
    text = await readBoundedText(message, maxBytes, errorCode);
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(`${errorCode}_encoding`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${errorCode}_json`);
  }
}
