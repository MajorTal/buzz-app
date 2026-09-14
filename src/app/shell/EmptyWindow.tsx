import { useState } from "react";
import type { WindowHost } from "../../features/windows/service";

/** A detached window whose pages were disabled, removed or moved away. */
export function EmptyWindow({ windows }: { windows: WindowHost }) {
  const [error, setError] = useState<string>();
  return (
    <div role="status" className="notice">
      <h1>No pages in this window</h1>
      <p>
        The pages that lived here were moved, disabled or removed. Move a page
        here from another window, or close this one.
      </p>
      {windows.close && (
        <button
          type="button"
          onClick={() =>
            windows
              .close?.()
              .catch((reason) =>
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
              )
          }
        >
          Close window
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
