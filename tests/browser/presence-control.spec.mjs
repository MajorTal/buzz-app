import { test, expect } from "./fixture.mjs";
import { contentionTests, confirmedSend } from "./presence-contention.mjs";
import { open } from "./timeline.mjs";
test.use({
  productionBroker: true,
  composerPublication: true,
  enforceQuotas: true,
  withoutPresence: true,
});
contentionTests(true);

// These are settlement controls, not performance samples: deliberately hold the
// browser ACK while retaining the real composer, broker and verified live path.
test("verified echo completes a send before its browser HTTP acknowledgement", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.__sendAbortEvidence = [];
    window.fetch = function (input, init) {
      if (String(input).endsWith("/publish")) {
        const event = JSON.parse(init.body);
        init.signal.addEventListener(
          "abort",
          () => {
            window.__sendAbortEvidence.push({
              id: event.id,
              reason: init.signal.reason?.name,
            });
          },
          { once: true },
        );
      }
      return original.call(this, input, init);
    };
  });
  await open(page, app);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let hostReceipt,
    hostStatus,
    browserResponses = 0;
  const received = (response) => {
    if (response.url().endsWith("/publish")) browserResponses++;
  };
  page.on("response", received);
  await page.route("**/api/relay/primary/publish", async (route) => {
    const response = await route.fetch();
    hostStatus = response.status();
    hostReceipt = await response.json();
    await held;
    // The browser may already have cancelled; fulfilling an obsolete route is
    // cleanup only and cannot be used as evidence of delivery.
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Echo before ACK control");
    await composer.evaluate((input) => input.form.requestSubmit());
    await expect.poll(() => app.report.publications.length).toBe(1);
    const event = app.report.publications[0].event;
    await confirmedSend(page, event);
    await expect
      .poll(() => hostReceipt)
      .toEqual({ accepted: true, event_id: event.id });
    expect(hostStatus).toBe(200);
    await expect
      .poll(() => page.evaluate(() => window.__sendAbortEvidence))
      .toEqual([{ id: event.id, reason: "AbortError" }]);
    expect(browserResponses).toBe(0);
    app.report.echoBeforeAck = {
      eventId: event.id,
      hostReceipt,
      hostStatus,
      browserResponses,
      abort: await page.evaluate(() => window.__sendAbortEvidence),
    };
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    page.off("response", received);
  }
});

test("send confirmation rejects an optimistic row without verified relay observation", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release, submitted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/publish", async (route) => {
    submitted = route.request().postDataJSON();
    await held;
    await route.abort("aborted").catch(() => {});
  });
  try {
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Unconfirmed optimistic control");
    await composer.evaluate((input) => input.form.requestSubmit());
    await expect.poll(() => submitted?.id).toBeTruthy();
    await expect(
      page.locator(`[data-message-id="${submitted.id}"]`),
    ).toContainText(submitted.content);
    await expect(composer).toHaveValue("");
    // The same assertion used by the measurement must reject this tempting false
    // positive. The default bounded expect timeout is unchanged.
    await expect(confirmedSend(page, submitted)).rejects.toThrow(
      "Outbox · 0 items",
    );
    expect(app.report.publications).toHaveLength(0);
    app.report.unconfirmedControl = {
      eventId: submitted.id,
      optimisticRowVisible: true,
      confirmationRejected: true,
    };
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
