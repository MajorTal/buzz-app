import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";
import {
  normalizeShortcode,
  suggestShortcode,
} from "../../features/relay/emoji";
import { prepareAttachment } from "../../features/messages/prepare-attachment";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { CustomEmoji } from "./CustomEmoji";
import styles from "./Emoji.module.css";

const message = (reason: unknown, fallback: string) =>
  reason instanceof Error && reason.message ? reason.message : fallback;

/** Desktop's custom emoji card: each member adds to their own kind-30030 set. */
export function CustomEmojiSettings({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section aria-labelledby="custom-emoji-settings-title">
      <Header
        id="custom-emoji-settings-title"
        title="Custom emoji"
        subtitle={
          <>
            Add your own custom emoji for everyone on this relay to use. Type{" "}
            <code>:name:</code> in messages and reactions.
          </>
        }
      />
      {connection.status === "ready" && (
        <Editor
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          active={active}
        />
      )}
    </section>
  );
}

function Editor({
  session,
  active,
}: {
  session: RelaySession;
  active(): boolean;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
  );
  const { add, upload } = session.emoji;
  const canAuthor = Boolean(add && upload);
  const [name, setName] = useState("");
  const [image, setImage] = useState<{ url: string; filename: string }>();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const uploadController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void session.emoji.ensure();
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
    };
  }, [session]);
  const live = () => mounted.current && active();
  const normalized = normalizeShortcode(name);
  const nameInvalid = name.trim().length > 0 && !normalized;
  const replacing =
    !!normalized && catalog.mine.some((e) => e.shortcode === normalized);
  const canSubmit = !!add && !!image && !!normalized && !uploading && !saving;

  async function choose(file: File) {
    if (!upload || uploading || saving || !live()) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    setError("");
    try {
      if (!file.type.startsWith("image/"))
        throw new Error("Choose an image file for custom emoji.");
      const prepared = await prepareAttachment(file, controller.signal);
      const result = await upload(prepared, controller.signal);
      if (!live()) return;
      if (!result.type.startsWith("image/"))
        throw new Error("Choose an image file for custom emoji.");
      setImage({ url: result.url, filename: file.name });
      const suggested = suggestShortcode(file.name);
      if (suggested && !nameRef.current.trim()) setName(suggested);
    } catch (reason) {
      if (!controller.signal.aborted && live())
        setError(message(reason, "Failed to upload emoji image."));
    } finally {
      if (uploadController.current === controller)
        uploadController.current = null;
      if (live()) setUploading(false);
    }
  }

  async function save() {
    if (!add || !image || !normalized || !canSubmit) return;
    setSaving(true);
    setError("");
    setAdded(undefined);
    try {
      const stored = await add(normalized, image.url);
      if (!live()) return;
      setName("");
      setImage(undefined);
      setAdded(stored);
    } catch (reason) {
      if (live()) setError(message(reason, "Failed to add emoji."));
    } finally {
      if (live()) setSaving(false);
    }
  }

  const preview = image && session.media(image.url);
  return (
    <div className="grid gap-6">
      {/* Authoring needs both the uploader and kind-30030 publishing; the reference has no copy for its absence. */}
      {canAuthor && (
        <form
          aria-labelledby="custom-emoji-add-title"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <InlineHeader id="custom-emoji-add-title" title="Add emoji" />
          <div className="grid gap-2">
            <InlineHeader
              level={4}
              title="Upload an image"
              subtitle="Square images work best. GIF, PNG, JPEG, and WebP files are supported."
            />
            <div className="flex items-center gap-3">
              <span className={styles.emojiPreview}>
                {preview && (
                  <img
                    alt="Selected custom emoji preview"
                    src={preview}
                    draggable={false}
                  />
                )}
              </span>
              <div className="grid min-w-0 gap-2">
                {image && (
                  <p className="truncate text-body-sm">{image.filename}</p>
                )}
                <Button
                  disabled={uploading || saving}
                  onClick={() => input.current?.click()}
                >
                  {uploading
                    ? "Uploading…"
                    : image
                      ? "Choose different image"
                      : "Upload image"}
                </Button>
              </div>
              <input
                ref={input}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-label="Upload image"
                accept="image/gif,image/png,image/jpeg,image/webp"
                disabled={uploading || saving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void choose(file);
                }}
              />
            </div>
          </div>
          <Field
            label="Give it a name"
            description="This is what you’ll type to add this emoji to messages and reactions."
            error={
              nameInvalid
                ? "Use only letters, numbers, hyphen, or underscore."
                : undefined
            }
          >
            <InputGroup leading=":" trailing=":">
              <Input
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="party-parrot"
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </InputGroup>
          </Field>
          {!nameInvalid &&
            (!image ? (
              <p className="text-body-sm text-muted">
                Choose an image first; Buzz will suggest a name from the
                filename.
              </p>
            ) : replacing ? (
              <p className="text-body-sm text-muted">
                You already have :{normalized}: — saving will replace its image.
              </p>
            ) : null)}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              disabled={uploading || saving || (!name && !image)}
              onClick={() => {
                setName("");
                setImage(undefined);
                setError("");
              }}
            >
              Clear
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!canSubmit}
            >
              {saving ? "Saving…" : "Save emoji"}
            </Button>
          </div>
        </form>
      )}
      <section aria-labelledby="custom-emoji-mine-title" className="grid gap-2">
        <InlineHeader
          id="custom-emoji-mine-title"
          title={
            catalog.mine.length
              ? `My emoji (${catalog.mine.length})`
              : "My emoji"
          }
        />
        {catalog.status === "error" ? (
          <>
            <p role="alert">{catalog.error}</p>
            <Button onClick={() => void session.emoji.refresh()}>
              Retry emoji
            </Button>
          </>
        ) : catalog.status !== "ready" ? (
          <p className="text-body-sm text-muted">Loading…</p>
        ) : !catalog.mine.length ? (
          // Its prompt points at the add form; the reference has no copy for an empty list without one.
          canAuthor && (
            <p className="text-body-sm text-muted">
              You haven&apos;t added any emoji yet. Add one above.
            </p>
          )
        ) : (
          <ul className="grid gap-2">
            {catalog.mine.map((emoji) => (
              <li key={emoji.shortcode} className="flex items-center gap-3">
                <CustomEmoji emoji={emoji} media={session.media} />
                <span className="truncate text-body-sm">
                  :{emoji.shortcode}:
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {added && (
        <ToastNotice
          title={`Added :${added}:`}
          tone="success"
          timeout={5000}
          onDismiss={() => setAdded(undefined)}
        />
      )}
    </div>
  );
}
