import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import {
  detailsDraftErrors,
  canonicalDetailsName,
  type ChannelDetails,
  type ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  ChannelPrivacyConfirmation,
  skipPrivacyConfirmation,
  rememberPrivacyConfirmation,
} from "./ChannelPrivacyConfirmation";
import { ChannelDurationField } from "./ChannelDurationField";
import { ChannelTextField } from "./ChannelTextField";
import { Switch } from "../../shared/design-system/ui/Switch";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../../features/relay/work-sessions";
import styles from "./Channels.module.css";

/** The capability owns writes; this view owns only a destination-bound editable draft. */
export function ChannelDetailsEditor({
  capability,
  channel,
  scope,
}: {
  scope: string;
  capability: ChannelDetailsCapability;
  channel: ChannelSummary;
}) {
  const id = channel.id;
  const attempt = useSyncExternalStore(capability.subscribe, () =>
    capability.snapshot(id),
  );
  const initial = () => ({
    capability,
    id,
    scope,
    skipWarning: false,
    loading: true,
    editing: false,
    confirmDiscard: false,
    pending: false,
    temporaryTtl: undefined as number | undefined,
    // Comparison only: retained through failed reads, never used as authority.
    baselineTtl: undefined as number | undefined,
    privacyChoice: undefined as ChannelDetailsDraft["visibility"] | undefined,
    error: "",
    base: undefined as ChannelDetails | undefined,
    draft: undefined as ChannelDetailsDraft | undefined,
  });
  const [state, setState] = useState(initial);
  // Discard drafts during render, not a frame after retargeting to another identity.
  const matches =
    state.capability === capability && state.id === id && state.scope === scope;
  if (!matches) setState(initial());
  const view = matches ? state : initial();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const privacyCancel = useRef<HTMLButtonElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const confirmDiscard = view.confirmDiscard && !attempt;
  const previousDiscard = useRef(confirmDiscard);
  useLayoutEffect(() => {
    if (view.editing && confirmDiscard !== previousDiscard.current)
      (confirmDiscard ? keepEditing.current : nameInput.current)?.focus();
    previousDiscard.current = confirmDiscard;
  }, [view.editing, confirmDiscard]);
  const previousPrivacyChoice = useRef(view.privacyChoice);
  const privateSwitch = useRef<HTMLSpanElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const privateControlId = useId();
  const statusId = useId();
  useLayoutEffect(() => {
    if (view.editing && view.privacyChoice !== previousPrivacyChoice.current) {
      (view.privacyChoice
        ? privacyCancel.current
        : privateSwitch.current
      )?.focus();
    }
    previousPrivacyChoice.current = view.privacyChoice;
  }, [view.editing, view.privacyChoice]);
  const patch = useCallback(
    (
      next:
        | Partial<typeof state>
        | ((old: typeof state) => Partial<typeof state>),
    ) =>
      setState((old) =>
        old.capability === capability && old.id === id && old.scope === scope
          ? { ...old, ...(typeof next === "function" ? next(old) : next) }
          : old,
      ),
    [capability, id, scope],
  );
  const load = useCallback(
    async (signal: AbortSignal) => {
      patch({ loading: true, error: "", privacyChoice: undefined });
      try {
        const base = await capability.load(id, signal);
        if (!signal.aborted)
          patch((old) => ({
            base,
            baselineTtl: base.ttlSeconds,
            // Preserve explicit choices, but adopt remote visibility/lifetime
            // for untouched fields. Unknown prior privacy must never reopen.
            draft: old.draft
              ? {
                  ...old.draft,
                  visibility:
                    old.base && old.draft.visibility !== old.base.visibility
                      ? old.draft.visibility
                      : base.visibility,
                  ttlSeconds:
                    old.draft.ttlSeconds === old.baselineTtl
                      ? base.ttlSeconds
                      : old.draft.ttlSeconds,
                }
              : undefined,
          }));
      } catch (error) {
        if (!signal.aborted)
          patch({
            base: undefined,
            error: String(error instanceof Error ? error.message : error),
          });
      } finally {
        if (!signal.aborted) patch({ loading: false });
      }
    },
    [capability, id, patch],
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    busy.current = false;
    void load(controller.signal);
    return () => {
      controller.abort();
    };
    // The owner and destination, not metadata updates, define this editor lifetime.
  }, [load]);
  const draft = attempt?.draft ?? view.draft;
  const pending = view.pending || attempt?.status === "saving";
  const locked = view.loading || pending || !!attempt;
  const canEdit = !!view.base?.canEdit;
  const normalized = draft && {
    ...draft,
    name: canonicalDetailsName(draft.name),
  };
  const errors = normalized ? detailsDraftErrors(normalized) : undefined;
  const dirty =
    !!normalized &&
    !!view.base &&
    (normalized.name !== view.base.name ||
      normalized.description !== view.base.description ||
      normalized.visibility !== view.base.visibility ||
      normalized.ttlSeconds !== view.base.ttlSeconds);
  const temporaryTtl =
    draft?.ttlSeconds ??
    view.temporaryTtl ??
    view.base?.ttlSeconds ??
    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS;
  const canSave =
    view.editing &&
    !view.privacyChoice &&
    !confirmDiscard &&
    !locked &&
    canEdit &&
    dirty &&
    !Object.values(errors ?? {}).some(Boolean);
  const edit = () => {
    if (attempt || (!view.loading && canEdit))
      patch({
        editing: true,
        confirmDiscard: false,
        draft: attempt?.draft ?? view.base,
        temporaryTtl: undefined,
        error: "",
      });
  };
  const close = () => {
    if (!pending && !busy.current)
      patch({
        editing: false,
        error: "",
        privacyChoice: undefined,
        confirmDiscard: false,
      });
  };
  // Protect the actual text, even when normalization would make Save a no-op.
  // A failed authority reload must not make the retained draft disposable.
  const unsaved =
    !attempt &&
    !!draft &&
    (!view.base ||
      draft.name !== view.base.name ||
      draft.description !== view.base.description ||
      draft.visibility !== view.base.visibility ||
      draft.ttlSeconds !== view.base.ttlSeconds);
  const requestClose = () => {
    if (pending || busy.current) return;
    if (view.privacyChoice) patch({ privacyChoice: undefined });
    else if (confirmDiscard) patch({ confirmDiscard: false });
    else if (unsaved) patch({ confirmDiscard: true });
    else close();
  };
  async function save() {
    const controller = lifetime.current;
    if (busy.current || !canSave || !view.base || !normalized || !controller)
      return;
    busy.current = true;
    patch({ pending: true, error: "" });
    try {
      await capability.save(view.base, normalized, controller.signal);
      if (controller.signal.aborted) return;
      await load(controller.signal);
      if (!controller.signal.aborted) patch({ editing: false });
    } catch (error) {
      if (!controller.signal.aborted)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        patch({ pending: false });
      }
    }
  }
  async function check() {
    const controller = lifetime.current;
    if (!controller || busy.current || attempt?.status !== "unconfirmed")
      return;
    busy.current = true;
    patch({ pending: true, error: "" });
    try {
      await capability.check(id, controller.signal);
      if (controller.signal.aborted) return;
      await load(controller.signal);
      if (!controller.signal.aborted) patch({ editing: false });
    } catch (error) {
      if (!controller.signal.aborted)
        patch({
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        patch({ pending: false });
      }
    }
  }
  const status =
    attempt?.status === "unconfirmed" || view.error ? (
      <div id={statusId} className={styles.detailsEditor}>
        {attempt?.status === "unconfirmed" && (
          <p role="status">
            The change may have been saved. Check its status before trying
            again. Checking never resends it. Closing this dialog does not undo
            the change.
          </p>
        )}
        {view.error && <p role="alert">{view.error}</p>}
        {!attempt && view.error && (
          <Button
            disabled={view.loading || pending}
            onClick={() => {
              if (lifetime.current) void load(lifetime.current.signal);
            }}
          >
            Reload details
          </Button>
        )}
      </div>
    ) : null;
  return (
    <section
      className={styles.detailsEditor}
      aria-label="Edit channel details"
      aria-busy={view.loading}
    >
      {(canEdit || attempt) && (
        <Button
          ref={editButton}
          onClick={edit}
          loading={pending}
          disabled={pending}
        >
          Edit details
        </Button>
      )}
      {!view.editing && status}
      <Dialog
        open={view.editing}
        headerGap="compact"
        footerGap={view.privacyChoice ? "compact" : "default"}
        step={
          confirmDiscard
            ? { key: "discard", scale: 0.95 }
            : view.privacyChoice
              ? { key: "privacy", scale: 0.95 }
              : { key: "details", scale: 1.05 }
        }
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
        dismissOnOutsideClick
        title={
          confirmDiscard
            ? "Discard changes?"
            : view.privacyChoice
              ? view.privacyChoice === "private"
                ? "Make channel private?"
                : "Make channel public?"
              : "Edit channel details"
        }
        description={
          confirmDiscard
            ? "Your channel details have unsaved changes."
            : undefined
        }
        closeLabel={
          confirmDiscard || view.privacyChoice
            ? "Back to edit channel details"
            : "Close edit channel details"
        }
        preventClose={pending}
        initialFocus={attempt ? undefined : nameInput}
        finalFocus={editButton}
        actions={
          confirmDiscard ? (
            <>
              <Button
                ref={keepEditing}
                onClick={() => patch({ confirmDiscard: false })}
              >
                Keep editing
              </Button>
              <Button variant="destructive" onClick={close}>
                Discard changes
              </Button>
            </>
          ) : view.privacyChoice ? (
            <>
              <Button
                ref={privacyCancel}
                onClick={() => patch({ privacyChoice: undefined })}
              >
                Cancel
              </Button>
              <Button
                variant="prominent"
                disabled={locked || !canEdit}
                onClick={() => {
                  if (draft && view.privacyChoice && !locked && canEdit) {
                    if (view.skipWarning) rememberPrivacyConfirmation(scope);
                    patch({
                      draft: { ...draft, visibility: view.privacyChoice },
                      privacyChoice: undefined,
                    });
                  }
                }}
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              {draft && (
                <span className={styles.detailsPrivate}>
                  <Switch
                    id={privateControlId}
                    ref={privateSwitch}
                    aria-label="Private"
                    checked={draft.visibility === "private"}
                    disabled={locked || !canEdit}
                    onCheckedChange={(checked) => {
                      if (locked || !canEdit) return;
                      const visibility = checked ? "private" : "public";
                      if (skipPrivacyConfirmation(scope))
                        patch({ draft: { ...draft, visibility } });
                      else
                        patch({
                          privacyChoice: visibility,
                          skipWarning: false,
                        });
                    }}
                  />
                  <label className="text-label-sm" htmlFor={privateControlId}>
                    Private
                  </label>
                </span>
              )}
              <Button disabled={pending} onClick={close}>
                {attempt ? "Close" : "Cancel"}
              </Button>
              {attempt?.status === "unconfirmed" ? (
                <Button
                  variant="prominent"
                  loading={view.pending}
                  disabled={view.loading}
                  onClick={() => void check()}
                >
                  Check save status
                </Button>
              ) : (
                <Button
                  type="submit"
                  form={formId}
                  variant="prominent"
                  loading={pending}
                  disabled={!canSave}
                >
                  Save changes
                </Button>
              )}
            </>
          )
        }
      >
        {confirmDiscard ? null : view.privacyChoice ? (
          <ChannelPrivacyConfirmation
            visibility={view.privacyChoice}
            checked={view.skipWarning}
            onCheckedChange={(skipWarning) => patch({ skipWarning })}
          />
        ) : (
          <form
            id={formId}
            className={styles.detailsEditor}
            aria-describedby={status ? statusId : undefined}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {draft && (
              <>
                <ChannelTextField
                  field="name"
                  inputRef={nameInput}
                  value={draft.name}
                  error={errors?.name}
                  disabled={locked || !canEdit}
                  onChange={(name) => patch({ draft: { ...draft, name } })}
                />
                <ChannelTextField
                  field="description"
                  value={draft.description}
                  error={errors?.description}
                  disabled={locked || !canEdit}
                  onChange={(description) =>
                    patch({ draft: { ...draft, description } })
                  }
                />
                <ChannelDurationField
                  temporary={draft.ttlSeconds !== undefined}
                  ttlSeconds={temporaryTtl}
                  error={errors?.lifetime}
                  disabled={locked || !canEdit}
                  onChange={(ttlSeconds) =>
                    patch({
                      draft: { ...draft, ttlSeconds },
                      temporaryTtl: ttlSeconds ?? temporaryTtl,
                    })
                  }
                />
              </>
            )}
            {view.editing && status}
          </form>
        )}
      </Dialog>
    </section>
  );
}
