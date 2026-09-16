/** Bound command receipt bytes before parsing or retaining secret-bearing text. */
export async function readReceiptText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Relay delivery receipt body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 16 * 1024)
        throw new Error("Relay delivery receipt exceeds the size limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
