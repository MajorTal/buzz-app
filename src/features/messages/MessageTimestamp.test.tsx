// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageTimestamp } from "./MessageTimestamp";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([
  [new Date(2026, 8, 24, 9, 5)],
  [new Date(2026, 8, 23, 9, 5)],
  [new Date(2026, 8, 17, 9, 5)],
  [new Date(2025, 8, 17, 9, 5)],
])(
  "shows only the clock for %s while retaining the full accessible date",
  (date) => {
    const { container } = render(
      <MessageTimestamp createdAt={date.getTime() / 1000} />,
    );
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      date.toISOString(),
    );
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    );
    expect(
      screen.getByText(
        date.toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long",
        }),
      ),
    ).toHaveClass("sr-only");
  },
);
it("keeps the continuation clock compact without dropping its accessible date", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} compact />,
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    /^9:05$/,
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent("2026");
});

it("refreshes cached styles when default locale or timezone changes", () => {
  const NativeFormat = Intl.DateTimeFormat;
  let locale = "en-GB";
  let timeZone = "Europe/London";
  function dateTimeFormat(
    requestedLocale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new NativeFormat(requestedLocale ?? locale, {
      timeZone,
      ...options,
    });
  }
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(dateTimeFormat);
  const date = new Date("2026-09-24T09:05:00Z");
  const { container, rerender } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  const assertDate = () => {
    expect(container.querySelector(".sr-only")).toHaveTextContent(
      new NativeFormat(locale, {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(date),
    );
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      new NativeFormat(locale, {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    );
  };
  assertDate();
  timeZone = "America/Los_Angeles";
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} />);
  assertDate();
  locale = "de-DE";
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} />);
  assertDate();
});
it("updates the visible clock, accessible date and datetime when a mounted row changes", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container, rerender } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  date.setDate(date.getDate() + 1);
  date.setHours(17);
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} compact />);
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    date.toISOString(),
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent(
    date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .formatToParts(date)
      .filter((part) => part.type !== "dayPeriod")
      .map((part) => part.value)
      .join("")
      .trim(),
  );
});
