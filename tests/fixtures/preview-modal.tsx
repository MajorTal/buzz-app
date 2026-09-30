// Shared destination previews beside the shared modal, with no app state.
import "../../src/shared/styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { PreviewCard } from "../../src/shared/design-system/ui/PreviewCard";

declare global {
  interface Window {
    previewClicks: string[];
  }
}
window.previewClicks = [];

function Destination({ name }: { name: string }) {
  return (
    <PreviewCard
      trigger={<a href={`#${name}`}>Open {name}</a>}
      aria-label={`${name} preview`}
      link={
        <a
          href={`#${name}`}
          onClick={(event) => {
            event.preventDefault();
            window.previewClicks.push(name);
          }}
        />
      }
    >
      <span className="text-label text-standard">{name} details</span>
    </PreviewCard>
  );
}

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main className="flex flex-col items-start gap-4 p-8">
      <Destination name="Background" />
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Modal"
        dismissOnOutsideClick
      >
        <Destination name="Inside" />
      </Dialog>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
