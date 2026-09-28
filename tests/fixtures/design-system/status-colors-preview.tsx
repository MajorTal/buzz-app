import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../../src/shared/design-system/styles/globals.css";
import { Avatar } from "../../../src/shared/design-system/ui/Avatar";

function Preview() {
  return (
    <main>
      <h1>Avatar badge colors</h1>
      <p>
        Online and Away use step-10 centers with a 1px step-11 outline. Offline,
        text colors, avatar sizes, and the Bézier notch stay unchanged.
      </p>
      <div className="comparison">
        {(["light", "dark"] as const).flatMap((mode) =>
          [true, false].map((before) => (
            <section
              key={`${mode}-${before}`}
              className={`panel ${mode} ${before ? "before" : ""}`}
            >
              <h2>
                {mode === "light" ? "Light" : "Dark"} ·{" "}
                {before ? "baseline · step 11" : "step 10 + outline"}
              </h2>
              {(["circle", "squircle"] as const).map((shape) => (
                <div className="avatar-row" key={shape}>
                  {(["online", "away", "offline"] as const).map((status) => (
                    <div className="example" key={status}>
                      <div className="sizes">
                        {(status === "offline"
                          ? (["large"] as const)
                          : (["small", "default", "large"] as const)
                        ).map((size) => (
                          <Avatar
                            key={size}
                            alt={shape === "circle" ? "Person" : "Agent"}
                            fallback={shape === "circle" ? "P" : "A"}
                            size={size}
                            shape={shape}
                            statusBadge={status}
                          />
                        ))}
                      </div>
                      <span>{status}</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )),
        )}
      </div>
      <p className="note">
        Real Avatar components at 24, 32, and 40px, in both shapes and themes.
        The outline is the visible status boundary: its lowest measured contrast
        is 3.30:1 on supported opaque surfaces, including selection and hover.
        The step-10 centers alone do not meet 3:1 on every surface.
      </p>
      <p className="note">
        “Baseline” reproduces Buzz 2.0’s unchanged step-11 badges. It is not a
        screenshot of the installed legacy Buzz app.
      </p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
