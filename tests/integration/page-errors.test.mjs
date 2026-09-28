import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchPageErrors } from "../browser/page-errors.mjs";

// A Playwright page reduced to the events and browser identity the watcher reads.
const fakePage = (engine) => {
  const page = new EventEmitter();
  page.context = () => ({
    browser: () => ({ browserType: () => ({ name: () => engine }) }),
  });
  return page;
};
const pageError = ({ name, message, stack }) =>
  Object.assign(new Error(message), { name, stack });
const cancel = (page, url, errorText = "Load request cancelled") =>
  page.emit("requestfailed", {
    url: () => url,
    failure: () => ({ errorText }),
  });

const query = "http://127.0.0.1:43347/api/relay/primary/query";
// Replayed from the Linux WebKit trace of navigation-repairs.spec.mjs:89 on main
// (run for 85d6bf82): Playwright split the console text at its first colon.
const reloadCancelLog = (url = query) =>
  pageError({
    name: "Fetch API cannot load http",
    message: `${url.slice("http:/".length)} due to access control checks.`,
    stack: `Fetch API cannot load ${url} due to access control checks.\n    at query (http://127.0.0.1:43347/assets/index.js:141:28966)`,
  });
const resizeObserverLoop = () =>
  pageError({
    name: "",
    message: "ResizeObserver loop completed with undelivered notifications.",
    stack: "",
  });

test("WebKit's log for a fetch the reload cancelled is kept as evidence but explained", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  assert.deepEqual(watched.errors, [
    `Fetch API cannot load ${query} due to access control checks.`,
  ]);
  assert.deepEqual(watched.unexplained(), []);
});

test("macOS WebKit's cancellation text is also a cancellation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query, "cancelled");
  page.emit("pageerror", reloadCancelLog());
  assert.deepEqual(watched.unexplained(), []);
});

test("the access-control log fails without a matching cancelled request", () => {
  for (const setup of [
    () => {},
    (page) => cancel(page, "http://127.0.0.1:43347/api/relay/primary/session"),
    (page) => cancel(page, query, "Could not connect to the server."),
  ]) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    setup(page);
    page.emit("pageerror", reloadCancelLog());
    assert.equal(watched.unexplained().length, 1);
  }
});

test("one cancellation explains one log", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("pageerror", reloadCancelLog());
  assert.equal(watched.unexplained().length, 1);
});

test("an unhandled rejection is never an engine report", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit(
    "pageerror",
    pageError({
      name: "Unhandled Promise Rejection",
      message: "TypeError: Load failed",
      stack: "",
    }),
  );
  assert.deepEqual(watched.unexplained(), [
    "Unhandled Promise Rejection: TypeError: Load failed",
  ]);
});

test("engine reports are WebKit-only", () => {
  const page = fakePage("chromium");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("pageerror", resizeObserverLoop());
  assert.equal(watched.unexplained().length, 2);
  const webkit = fakePage("webkit");
  const watchedWebkit = watchPageErrors(webkit);
  webkit.emit("pageerror", resizeObserverLoop());
  assert.deepEqual(watchedWebkit.unexplained(), []);
  assert.equal(watchedWebkit.errors.length, 1);
});

test("an application error keeps its name", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  page.emit("pageerror", new TypeError("a: b"));
  assert.deepEqual(watched.unexplained(), ["TypeError: a: b"]);
});
