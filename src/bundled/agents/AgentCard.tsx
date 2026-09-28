import { npubEncode } from "nostr-tools/nip19";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuNote,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  DotsThreeIcon,
  UsersIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { avatarSource } from "../../shared/avatar-source";
import { usePresenceStatus } from "../../features/presence/react";
import type { AgentLibrary } from "../../features/agents/library";
import type { AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";

export function AgentCard({
  name,
  avatar,
  identities,
  session,
  editable = [],
  onEdit,
  onDuplicate,
  onDelete,
  children,
  identityLabel = (identity) => identity.name,
}: {
  children?: ReactNode;
  identityLabel?: (identity: { pubkey: string; name: string }) => string;
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session?: RelaySession;
  editable?: AgentView[];
  onEdit?: ((agent: AgentView, avatar?: string) => void) | undefined;
  onDuplicate?: ((agent: AgentView) => void) | undefined;
  onDelete?: ((agent: AgentView) => void) | undefined;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const presence = usePresenceStatus(
    session?.presence,
    identities.length === 1 ? identities[0]?.pubkey : undefined,
  );
  const managed = editable.length === 1 ? editable[0] : undefined;
  const status = managed?.status;
  const settled =
    status === "running" ? presence === "online" : presence !== "online";
  useEffect(() => {
    const owner = session?.presence;
    if (!owner || !status || settled) return;
    // The harness publishes presence just after native start/stop confirms,
    // so one read can race it. Re-read at the owner's gate, then resume its
    // normal cadence even if relay evidence never agrees.
    owner.refresh();
    let checks = 0;
    const timer = setInterval(() => {
      owner.refresh();
      if (++checks === 6) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [session?.presence, status, settled]);
  const source = avatarSource(managed?.picture ?? avatar);
  const managedPicture = useAvatarPreview(
    managed?.picture ?? "",
    managed?.relayUrl,
  );
  const picture =
    managed?.picture != null
      ? managedPicture
      : source?.startsWith("data:")
        ? source
        : source
          ? session?.media(source, "small")
          : undefined;
  return (
    <article
      aria-label={`Agent ${name}`}
      className="relative flex min-w-0 flex-col gap-4 rounded-2xl border border-primary p-4"
    >
      {onEdit && (
        <div className="absolute right-2 top-2">
          <MenuRoot>
            <MenuTrigger
              ref={trigger}
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="compact"
                  icon={<DotsThreeIcon size={18} aria-hidden="true" />}
                />
              }
            />
            <MenuPopup align="end" size="wide">
              {editable.length ? (
                editable.map((agent) => (
                  <Fragment key={agent.id}>
                    <MenuItem
                      onClick={() => {
                        // The menu item unmounts; return from the dialog to the card.
                        trigger.current?.focus();
                        onEdit(agent, source);
                      }}
                    >
                      {editable.length === 1 ? (
                        "Edit"
                      ) : (
                        <ChoiceRow
                          label={`Edit ${identityLabel(agent)}`}
                          description={
                            <>
                              <span className="block break-all text-body-sm text-secondary">
                                {agent.relayUrl}
                              </span>
                              <span className="block break-all text-mono-sm text-secondary">
                                {npubEncode(agent.pubkey)}
                              </span>
                            </>
                          }
                        />
                      )}
                    </MenuItem>
                    {onDuplicate && (
                      <MenuItem
                        onClick={() => {
                          trigger.current?.focus();
                          onDuplicate(agent);
                        }}
                      >
                        {editable.length === 1
                          ? "Duplicate"
                          : `Duplicate ${identityLabel(agent)}`}
                      </MenuItem>
                    )}
                    {onDelete && (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          tone="danger"
                          onClick={() => {
                            trigger.current?.focus();
                            onDelete(agent);
                          }}
                        >
                          {editable.length === 1
                            ? "Delete"
                            : `Delete ${identityLabel(agent)}`}
                        </MenuItem>
                      </>
                    )}
                  </Fragment>
                ))
              ) : (
                <>
                  <MenuItem disabled>Edit</MenuItem>
                  <MenuNote>
                    {identities.length
                      ? "Import this identity to edit in Foundation."
                      : "No linked identity to edit."}
                  </MenuNote>
                </>
              )}
            </MenuPopup>
          </MenuRoot>
        </div>
      )}
      <div
        className={
          children
            ? "flex min-w-0 items-center gap-3 pr-6"
            : "flex flex-1 flex-col gap-4"
        }
      >
        <div
          className={
            children
              ? "shrink-0"
              : "flex min-h-36 items-center justify-center py-5"
          }
        >
          <Avatar
            alt={name}
            fallback={name}
            src={picture ?? null}
            size="large"
            shape="squircle"
            statusBadge={presence === "unknown" ? undefined : presence}
          />
        </div>
        <h3 className="m-0 min-w-0 truncate text-label" title={name}>
          {name}
        </h3>
      </div>
      {children}
      {identities.length && !children ? (
        <Accordion
          items={[
            {
              value: "identities",
              title: (
                <span className="flex items-center gap-2">
                  <UsersIcon size={16} aria-hidden="true" />
                  <span className="sr-only">{name}: </span>
                  {identities.length}{" "}
                  {identities.length === 1 ? "identity" : "identities"}
                </span>
              ),
              content: (
                <ul className="mt-2 space-y-3 border-t border-primary pt-3">
                  {identities.map((identity) => (
                    <li key={identity.pubkey}>
                      <span className="font-semibold text-primary">
                        {identityLabel(identity)}
                      </span>
                      <p className="m-0 mt-1 select-all break-all text-mono-sm">
                        {npubEncode(identity.pubkey)}
                      </p>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      ) : !children ? (
        <p className="m-0 mt-1 text-body-sm text-secondary">
          No linked identity
        </p>
      ) : null}
    </article>
  );
}
