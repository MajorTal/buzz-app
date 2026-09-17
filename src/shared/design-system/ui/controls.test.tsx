// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { Button } from "./Button";
import { Field } from "./Field";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Radio, RadioGroup } from "./RadioGroup";
import { Checkbox } from "./Checkbox";
import { SearchField } from "./SearchField";

afterEach(cleanup);

test("a loading action keeps its name and blocks pointer, keyboard and form submission until released", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  const submit = vi.fn((event) => event.preventDefault());
  const view = render(
    <form onSubmit={submit}>
      <Button type="submit" loading onClick={action}>
        Save changes
      </Button>
    </form>,
  );
  const button = screen.getByRole("button", { name: "Save changes" });
  expect(button).toHaveAttribute("aria-busy", "true");
  await user.click(button);
  button.focus();
  await user.keyboard("{Enter} ");
  expect(action).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  view.rerender(
    <form onSubmit={submit}>
      <Button type="submit" onClick={action}>
        Save changes
      </Button>
    </form>,
  );
  await user.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
});

test("loading non-native actions prevent activation and navigation", async () => {
  const action = vi.fn();
  const user = userEvent.setup();
  render(
    <Button
      loading
      nativeButton={false}
      render={<a href="#example" />}
      onClick={action}
    >
      Open note
    </Button>,
  );
  const link = screen.getByRole("button", { name: "Open note" });
  let prevented = false;
  const observe = (event: MouseEvent) => {
    prevented = event.defaultPrevented;
  };
  document.addEventListener("click", observe);
  try {
    await user.click(link);
  } finally {
    document.removeEventListener("click", observe);
  }
  expect(action).not.toHaveBeenCalled();
  expect(prevented).toBe(true);
});

test("fields connect labels, help and errors and keep textarea edits controlled", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("Draft");
    return (
      <>
        <Field label="Title" description="A short name" error="Name required">
          <Input required />
        </Field>
        <Field label="Description">
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <output>{value}</output>
      </>
    );
  }
  render(<Example />);
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(title).toHaveAccessibleDescription(/A short name/);
  expect(title).toHaveAccessibleDescription(/Name required/);
  expect(title).toHaveAttribute("aria-invalid", "true");
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    " notes",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Draft notes");
});

test("radio and checkbox labels change the actual form values while disabled choices do not", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Preferences">
      <RadioGroup name="mode" aria-label="Color mode" defaultValue="light">
        <Radio value="light" label="Light" />
        <Radio value="dark" label="Dark" />
        <Radio value="unavailable" label="Unavailable" disabled />
      </RadioGroup>
      <Checkbox name="summary" value="yes" label="Include summary" />
    </form>,
  );
  await user.click(screen.getByText("Dark"));
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  await user.click(screen.getByText("Unavailable"));
  expect(screen.getByRole("radio", { name: "Unavailable" })).not.toBeChecked();
  await user.click(screen.getByText("Include summary"));
  expect(
    screen.getByRole("checkbox", { name: "Include summary" }),
  ).toBeChecked();
  expect(
    Object.fromEntries(
      new FormData(screen.getByRole("form") as HTMLFormElement),
    ),
  ).toEqual({ mode: "light", summary: "yes" });
});

test("search forwards keyboard events and ref, and clearing restores input focus", async () => {
  const user = userEvent.setup();
  const ref = createRef<HTMLElement>();
  const onKeyDown = vi.fn();
  function Example() {
    const [value, setValue] = useState("draft");
    return (
      <SearchField
        label="Notes"
        value={value}
        onValueChange={setValue}
        inputRef={ref}
        onKeyDown={onKeyDown}
      />
    );
  }
  render(<Example />);
  const input = screen.getByRole("searchbox", { name: "Notes" });
  expect(ref.current).toBe(input);
  await user.click(screen.getByRole("button", { name: "Clear notes" }));
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(onKeyDown).toHaveBeenCalled();
});
