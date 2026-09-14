const pattern =
  /buzz:\/\/message\?channel=([a-zA-Z0-9_-]+)&id=([a-f0-9]{64})(?![a-f0-9])/g;

/** Recognize task coordinates in prose or an explicitly offered link destination. */
export function taskReferences(text: string) {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    channel: match[1] ?? "",
    root: match[2] ?? "",
  }));
}

export function taskReference(channel: string, root: string) {
  return `buzz://message?channel=${channel}&id=${root}`;
}
