import { Popover } from "@base-ui/react/popover";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { avatarPictureError, emojiAvatar, uploadAvatar } from "./avatar-upload";
import { useAvatarPreview } from "./use-avatar-preview";
import type { EmojiSearchSelection } from "../../bundled/emoji/emoji-mart";

type Props = {
  value: string;
  name: string;
  community?: string | undefined;
  shape?: "circle" | "squircle";
  disabled?: boolean;
  onChange(value: string): void;
  onBusyChange?: ((busy: boolean) => void) | undefined;
};

/** One draft editor for humans and agents; the enclosing form owns profile Save. */
export function AvatarEditor(props: Props) {
  const [open, setOpen] = useState(false);
  const preview = useAvatarPreview(props.value, props.community);
  const pictureError = avatarPictureError(props.value);
  const errorId = useId();
  const callback = useRef(props.onBusyChange);
  callback.current = props.onBusyChange;
  useEffect(() => {
    callback.current?.(open);
    return () => callback.current?.(false);
  }, [open]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="relative mx-auto size-36 shrink-0">
        <Avatar
          src={preview}
          alt="Avatar"
          fallback={props.name}
          size="fill"
          shape={props.shape ?? "circle"}
        />
        <div className="absolute bottom-0 right-0 rounded-full bg-surface-panel p-1">
          <Popover.Trigger
            render={
              <IconButton
                variant="prominent"
                aria-label="Edit avatar"
                aria-describedby={pictureError ? errorId : undefined}
                icon={<PencilSimpleIcon size={24} />}
                disabled={props.disabled}
              />
            }
          />
        </div>
      </div>
      {pictureError && (
        <p id={errorId} role="alert" className="text-body-sm text-danger">
          {pictureError}
        </p>
      )}
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="center"
          sideOffset={12}
          collisionPadding={12}
          collisionAvoidance={{
            side: "shift",
            align: "shift",
            fallbackAxisSide: "none",
          }}
          style={{ zIndex: "var(--layer-popover)" }}
        >
          <Popover.Popup
            data-buzz-ui=""
            className="popover-surface w-[22.5rem] max-w-[calc(100vw-1.5rem)] max-h-[min(47.5rem,var(--available-height))] overflow-auto p-4 text-body"
          >
            <Popover.Title className="sr-only">Edit avatar</Popover.Title>
            {open && (
              <AvatarDraft
                key={props.community ?? "local"}
                {...props}
                done={(value) => {
                  props.onChange(value);
                  setOpen(false);
                }}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AvatarDraft({
  value,
  name,
  community,
  shape = "circle",
  disabled = false,
  done,
}: Props & { done(value: string): void }) {
  const colorId = useId();
  const [picture, setPicture] = useState(value);
  const [mode, setMode] = useState<"image" | "emoji">("image");
  const [emoji, setEmoji] = useState("😀");
  const [color, setColor] = useState("#FFF4CC");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function upload(makeFile: () => Promise<File>, apply = false) {
    if (disabled || pending.current || !community) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      const file = await makeFile();
      request.signal.throwIfAborted();
      const url = await uploadAvatar(file, community, request.signal);
      if (!request.signal.aborted) {
        if (apply) done(url);
        else setPicture(url);
      }
    } catch (reason) {
      if (!request.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Image upload failed. Try again.",
        );
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const pictureError = avatarPictureError(picture);
  const preview = useAvatarPreview(picture, community);
  return (
    <div className="space-y-4">
      <Tabs
        value={mode}
        label="Avatar source"
        variant="panel"
        items={[
          { value: "image", label: "Image" },
          { value: "emoji", label: "Emoji" },
        ]}
        onValueChange={(next) => {
          if (!busy && !disabled) {
            setMode(next);
            setError("");
          }
        }}
      />
      <div className="mx-auto size-36 my-6">
        {mode === "emoji" ? (
          <div
            role="img"
            aria-label="Emoji avatar preview"
            data-avatar-shape={shape}
            className="flex size-full items-center justify-center"
            style={{ background: color }}
          >
            {/* Artwork coordinates match emojiAvatar's 512px canvas, not UI type. */}
            <svg viewBox="0 0 512 512" className="size-full" aria-hidden="true">
              <text
                x="256"
                y="286"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="258"
                fontFamily='"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
              >
                {emoji}
              </text>
            </svg>
          </div>
        ) : (
          <Avatar
            src={preview}
            alt="Avatar preview"
            fallback={name}
            size="fill"
            shape={shape}
          />
        )}
      </div>
      {mode === "image" ? (
        <div className="space-y-3">
          <fieldset
            aria-label="Upload avatar image"
            className="rounded-xl bg-surface-inset p-6 text-center"
            data-dragging={dragging || undefined}
            onDragOver={(event) => {
              event.preventDefault();
              if (!disabled && !busy && community) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void upload(async () => file);
            }}
          >
            <ArrowUpIcon className="mx-auto mb-2" size={28} />
            <Button
              variant="link"
              disabled={disabled || busy || !community}
              onClick={() => input.current?.click()}
            >
              {dragging ? "Drop image here" : "Drop or browse"}
            </Button>
            <input
              ref={input}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label="Upload an image"
              accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif"
              disabled={disabled || busy || !community}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(async () => file);
              }}
            />
          </fieldset>
          <Field label="Picture URL (optional)" error={pictureError}>
            <Input
              type="url"
              placeholder="Paste an image URL"
              maxLength={2048}
              disabled={disabled || busy}
              value={picture}
              onChange={(event) => {
                setPicture(event.target.value);
                setError("");
              }}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          <AvatarEmojiPicker disabled={disabled || busy} onSelect={setEmoji} />
          <div className="flex items-end gap-3">
            <Field label="Emoji">
              <Input
                value={emoji}
                maxLength={64}
                disabled={disabled || busy}
                onChange={(event) => setEmoji(event.target.value)}
              />
            </Field>
            <Field label="Background color" controlId={colorId}>
              <input
                id={colorId}
                type="color"
                value={color}
                disabled={disabled || busy}
                onChange={(event) => setColor(event.target.value)}
              />
            </Field>
          </div>
        </div>
      )}
      {busy && (
        <p role="status" className="text-body-sm">
          Uploading avatar…
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      <p className="text-body-sm text-subtle">
        {community
          ? "Uploads go to this community. Done selects the avatar; Save applies your profile changes."
          : "Select a community in the sidebar to upload an image or emoji. Your local default can use a public HTTPS image URL."}
      </p>
      <div className="flex flex-wrap justify-between gap-2">
        <Button
          variant="ghost"
          disabled={(!value && !picture) || disabled || busy}
          onClick={() => done("")}
        >
          Remove avatar
        </Button>
        <Button
          variant="prominent"
          disabled={
            disabled ||
            busy ||
            (mode === "emoji" ? !community || !emoji.trim() : !!pictureError)
          }
          onClick={() => {
            if (mode === "emoji")
              void upload(() => emojiAvatar(emoji, color), true);
            else done(picture);
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}

const rootScale = () =>
  (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    16) / 16;

function AvatarEmojiPicker({
  onSelect,
  disabled,
}: {
  onSelect(value: string): void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onSelect);
  callback.current = (value) => {
    if (!disabled) onSelect(value);
  };
  const [error, setError] = useState(false);
  const [scale, setScale] = useState(rootScale);
  const search = useRef("");
  const focusPicker = useRef(true);
  const searchSelection = useRef<EmojiSearchSelection | undefined>(undefined);
  useEffect(() => {
    const observer = new MutationObserver(() => setScale(rootScale()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let retired = false;
    let dispose: (() => void) | undefined;
    void import("../../bundled/emoji/emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (retired) return;
        dispose = mountEmojiMart({
          host: element,
          scope: "avatar",
          autoFocus: focusPicker.current,
          perLine: 6,
          emojiSize: 28 * scale,
          emojiButtonSize: 36 * scale,
          search: search.current,
          searchSelection,
          searchChange(value) {
            search.current = value;
          },
          entries: [],
          media: () => undefined,
          select: (value) => callback.current(value),
          close() {},
        });
      })
      .catch(() => {
        if (!retired) setError(true);
      });
    return () => {
      retired = true;
      // Shadow focus is retargeted to the picker host. Geometry changes must
      // not reclaim focus from the manual emoji field or another avatar control.
      if (dispose)
        focusPicker.current = element.contains(
          element.ownerDocument.activeElement,
        );
      dispose?.();
    };
  }, [scale]);
  return (
    <div
      inert={disabled}
      className="max-w-full overflow-auto [&_em-emoji-picker]:w-full [&_em-emoji-picker]:h-[min(17.5rem,35dvh)]"
    >
      <div ref={host} tabIndex={-1} />
      {error && (
        <p role="alert">
          Could not load the emoji picker. Reopen it to retry, or paste an emoji
          below.
        </p>
      )}
    </div>
  );
}
