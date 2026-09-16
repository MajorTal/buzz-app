import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { createBestieRealtime } from "../../dev/bestie-realtime.mjs";

// Only inference/ACP is modeled. Actual host validation, process lifetime, browser
// capture queues, AudioWorklet, React controls and permission forwarding run here.
const agentSource = `
import { createInterface } from 'node:readline';
const send = event => console.log(JSON.stringify({jsonrpc:'2.0',...event}));
const update = value => send({method:'_buzz/unstable/realtime/update',params:{sessionId:'session',streamId:'stream',update:value}});
let ready=false, spoke=false, permission, tone=false, toneSamples=0, toneSequence=0;
process.on('message', command => {
 if(command.type==='ready') {
  ready=true;update({type:'ready'});
 } else if(command.type==='ask') {
  permission=command.id;
  send({id:command.id,method:'session/request_permission',params:{sessionId:'session',toolCall:{toolCallId:command.id,title:command.title,rawInput:{command:'buzz channels list'}},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});
 } else if(command.type==='history') {
  for(let i=1;i<=20;i++) {
   update({type:'speech_started'});
   send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Transcript message '+i+'. A little more detail to read while Bestie stays visible above the conversation.'}}}});
  }
 } else if(command.type==='speak') {
  tone=true; toneSamples=0; toneSequence++;
 } else if(command.type==='cancel') {
  tone=false;
  update({type:'speech_started'});
  send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call_update',toolCallId:permission,status:'failed'}}});
 } else if(command.type==='exit') process.exit(0);
});
for await(const line of createInterface({input:process.stdin})) {
 const event=JSON.parse(line);
 if(event.method==='initialize') send({id:event.id,result:{agentCapabilities:{_meta:{buzz:{realtimeAudio:1}}}}});
 else if(event.method==='session/new') send({id:event.id,result:{sessionId:'session'}});
 else if(event.method==='session/prompt') {process.send({type:'prompt'});if(!process.env.BESTIE_TEST_HOLD_READY){ready=true;update({type:'ready'});}}
 else if(event.method==='_buzz/unstable/realtime/append') {
  send({id:event.id,result:{}});
  process.send({type:'capture',bytes:Buffer.from(event.params.data,'base64').length});
  // Keep playback active until the test explicitly interrupts it.
  if(tone) {
   const pcm=Buffer.alloc(Buffer.from(event.params.data,'base64').length);
   for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(Math.sin((toneSamples+i)*Math.PI/60)*6000),i*2);
   update({type:'audio',responseId:'tone-'+toneSequence,itemId:'tone-audio-'+toneSequence,startSample:toneSamples,data:pcm.toString('base64')});
   toneSamples+=pcm.length/2;
  }
  if(ready&&!spoke) {
   spoke=true;
   const pcm=Buffer.alloc(4800);
   for(let i=0;i<2400;i++)pcm.writeInt16LE(Math.round(Math.sin(i*Math.PI/60)*200),i*2);
   update({type:'audio',responseId:'reply',itemId:'reply-audio',startSample:0,data:pcm.toString('base64')});
   send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture voice reply.'}}}});
   update({type:'response_done',responseId:'reply',status:'completed'});
  }
 } else if(event.method==='_buzz/unstable/realtime/playback') {
  process.send({type:'playback',samples:event.params.playback.playedSamples});
  send({id:event.id,result:{}});
 } else if(!event.method) {
  process.send({type:'approval',id:event.id,option:event.result.outcome.optionId});
  send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call_update',toolCallId:event.id,status:'completed'}}});
 } else if(event.id!==undefined) send({id:event.id,result:{}});
}
`;

async function fixture(page, { holdReady = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bestie-browser-"));
  const script = join(directory, "agent.mjs");
  await writeFile(script, agentSource);
  const ownerKey = generateSecretKey();
  const children = [],
    events = [],
    errors = [];
  const host = createBestieRealtime({
    endpoint: "ws://127.0.0.1:1/v1/realtime",
    ownerKey,
    stateDirectory: directory,
    stopTimeoutMs: 30,
    spawnAgent(_command, _args, options) {
      const index = children.length;
      const child = spawn(process.execPath, [script], {
        ...options,
        env: { ...options.env, BESTIE_TEST_HOLD_READY: holdReady ? "1" : "" },
        stdio: ["pipe", "pipe", "ignore", "ipc"],
      });
      child.on("message", (event) => events.push({ ...event, child: index }));
      children.push(child);
      return child;
    },
  });
  const viewer = getPublicKey(ownerKey);
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "bestie-browser-host",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const parts = new URL(req.url, "http://localhost").pathname.split(
              "/",
            );
            if (
              parts[1] !== "api" ||
              parts[2] !== "relay" ||
              parts[4] !== "bestie"
            )
              return next();
            const relay = decodeURIComponent(parts[3]);
            if (
              !["https://alpha.example", "https://beta.example"].includes(relay)
            ) {
              res.writeHead(403).end();
              return;
            }
            void host.handle(req, res, { relay, viewer });
          });
        },
      },
    ],
    define: {
      "import.meta.env.VITE_BESTIE_REALTIME": JSON.stringify("1"),
      "import.meta.env.VITE_BESTIE_TEST_VIEWER": JSON.stringify(viewer),
    },
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  // A synthetic MediaStream replaces only the physical microphone, never the
  // production AudioWorklet or media transport. Tests cannot record user audio.
  await page.addInitScript(() => {
    window.bestieMicrophones = [];
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      value: async () => {
        const context = new AudioContext({ sampleRate: 24000 });
        await context.resume();
        const destination = context.createMediaStreamDestination();
        const source = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.15;
        source.connect(gain).connect(destination);
        source.start();
        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          source.stop();
          void context.close();
        };
        window.bestieMicrophones.push(track);
        return destination.stream;
      },
    });
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/bestie.html`;
  try {
    await page.goto(url);
  } catch (error) {
    await host.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    children,
    events,
    errors,
    control(value) {
      children.at(-1).send(value);
    },
    microphones: () =>
      page.evaluate(
        () =>
          window.bestieMicrophones.filter(
            (track) => track.readyState === "live",
          ).length,
      ),
    async close() {
      await page.goto("about:blank");
      await host.close();
      await server.close();
      ownerKey.fill(0);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const button = (page, name) => page.getByRole("button", { name, exact: true });

test("ACP streams complete sparse notifications and audio, then closes its agent", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const result = await page.evaluate(async () => {
      const url = `/api/relay/${encodeURIComponent("https://alpha.example")}/bestie`;
      const headers = {
        Authorization: `Bearer ${crypto.randomUUID()}`,
        "Content-Type": "application/json",
      };
      const authorization = await fetch(`${url}?op=authorize`, {
        method: "POST",
        headers,
      });
      if (!authorization.ok) throw Error("Call authorization unavailable");
      const { ticket } = await authorization.json();
      const source = new EventSource(`${url}?op=events&ticket=${ticket}`);
      const events = [];
      let failure;
      source.onmessage = ({ data }) => events.push(JSON.parse(data));
      source.onerror = () => {
        source.close();
        failure = Error("Event stream disconnected");
      };
      async function receive(predicate) {
        const deadline = Date.now() + 10000;
        for (;;) {
          if (failure) throw failure;
          const event = events.find(predicate);
          if (event) return event;
          if (Date.now() > deadline) throw Error("Notification deadline");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      async function send(id, method, params = {}) {
        const response = await fetch(`${url}?op=rpc`, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        if (!response.ok)
          throw Error(`ACP request rejected (${response.status})`);
      }
      try {
        await receive((event) => event.method === "bestie/ready");
        await send(1, "initialize");
        await receive((event) => event.id === 1);
        await send(2, "session/new");
        const sessionId = (await receive((event) => event.id === 2)).result
          .sessionId;
        await send(3, "session/prompt", { sessionId, prompt: [] });
        // No later request can flush a partial ready line: capture waits for it.
        const ready = await receive(
          (event) => event.params?.update?.type === "ready",
        );
        await send(4, "_buzz/unstable/realtime/append", {
          sessionId,
          streamId: ready.params.streamId,
          data: btoa("\0".repeat(480)),
        });
        const audio = await receive(
          (event) => event.params?.update?.type === "audio",
        );
        const done = await receive(
          (event) => event.params?.update?.type === "response_done",
        );
        return {
          audioBytes: atob(audio.params.update.data).length,
          status: done.params.update.status,
        };
      } finally {
        source.close();
      }
    });
    expect(result).toEqual({ audioBytes: 4800, status: "completed" });
    await expect
      .poll(
        () =>
          f.children[0].exitCode !== null || f.children[0].signalCode !== null,
      )
      .toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

async function chooseSetting(page, label) {
  await button(page, "Bestie call settings").click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

async function start(page, f) {
  await button(page, "Start Bestie voice conversation").click();
  await expect(button(page, "Mute Bestie microphone")).toBeEnabled();
  await expect(page.getByRole("status")).not.toContainText("Listening through");
  await expect.poll(f.microphones).toBe(1);
  await expect
    .poll(() =>
      f.events.some(
        (event) =>
          event.type === "capture" &&
          event.bytes > 0 &&
          event.child === f.children.length - 1,
      ),
    )
    .toBe(true);
}

test("Bestie gestures with speech phrases, respects reduced motion, and settles after interruption", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  try {
    await start(page, f);
    const avatar = page.getByRole("img", { name: "Bestie", exact: true });
    await expect(avatar).toHaveCSS("width", "160px");
    await expect(avatar.locator("..")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect
      .poll(() =>
        f.events.some(
          (event) => event.type === "playback" && event.samples > 0,
        ),
      )
      .toBe(true);
    await expect(avatar).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    f.children[0].send({ type: "speak" });
    await expect
      .poll(() =>
        avatar.evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).a,
        ),
      )
      .toBeGreaterThan(1.01);
    await capture(page, testInfo, "speaking");
    const firstTilt = await avatar.evaluate(
      (element) => new DOMMatrix(getComputedStyle(element).transform).b,
    );
    f.children[0].send({ type: "cancel" });
    await expect(avatar).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    f.children[0].send({ type: "speak" });
    await expect
      .poll(() =>
        avatar.evaluate(
          (element, initialTilt) =>
            new DOMMatrix(getComputedStyle(element).transform).b *
            Math.sign(initialTilt),
          firstTilt,
        ),
      )
      .toBeLessThan(-0.005);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(avatar).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await expect
      .poll(() => avatar.evaluate((element) => Number(element.style.opacity)))
      .toBeGreaterThan(0.95);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    f.children[0].send({ type: "cancel" });
    await expect(avatar).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await expect(button(page, "Mute Bestie microphone")).toBeEnabled();
  } finally {
    await f.close();
  }
});

test("call controls keep their space and keyboard focus through connecting and cancellation", async ({
  page,
}, testInfo) => {
  const f = await fixture(page, { holdReady: true });
  try {
    const call = button(page, "Start Bestie voice conversation");
    const footer = page.locator("footer");
    const before = await footer.boundingBox();
    await call.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => f.events.some((event) => event.type === "prompt"))
      .toBe(true);
    const hangup = button(page, "End Bestie conversation");
    await expect(hangup).toBeFocused();
    await capture(page, testInfo, "connecting");
    await expect(button(page, "Mute Bestie microphone")).toBeDisabled();
    expect((await footer.boundingBox()).height).toBe(before.height);
    await expect(footer).toHaveAttribute("data-instant", "true");
    await expect(call).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(button(page, "Start Bestie voice conversation")).toBeFocused();
    await expect(page.getByRole("status")).toBeEmpty();
    await expect(button(page, "End Bestie conversation")).toHaveCount(0);
    expect((await footer.boundingBox()).height).toBe(before.height);
    // Restart with a pointer, then explicitly release the connection gate.
    await call.click();
    await expect
      .poll(() => f.events.filter((event) => event.type === "prompt").length)
      .toBe(2);
    await expect(footer).toHaveAttribute("data-instant", "false");
    f.control({ type: "ready" });
    await expect(button(page, "Mute Bestie microphone")).toBeEnabled();
    await expect(button(page, "End Bestie conversation")).toBeEnabled();
  } finally {
    await f.close();
  }
});

async function capture(page, testInfo, name) {
  if (!process.env.BESTIE_REVIEW_SCREENSHOTS) return;
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page
    .getByRole("complementary", { name: "Bestie", exact: true })
    .screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function toggleTranscript(page) {
  await button(page, "Bestie call settings").click();
  const setting = page.getByRole("menuitemcheckbox", {
    name: "Show transcript",
  });
  await expect(setting).toBeEnabled();
  await setting.click();
}

test("actual Bestie call keeps duplex media and thinking through panel relocation, then stops on hide", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  try {
    await chooseSetting(page, "High");
    await start(page, f);
    const transcript = page.getByRole("log", { name: "Bestie transcript" });
    // Playback proves the response arrived while the transcript was hidden.
    await expect
      .poll(() =>
        f.events.some(
          (event) => event.type === "playback" && event.samples > 0,
        ),
      )
      .toBe(true);
    await expect(transcript).toHaveCount(0);
    await capture(page, testInfo, "listening");
    await toggleTranscript(page);
    await expect(transcript).toContainText("Fixture voice reply.");
    const message = transcript.locator("[data-message-id]");
    await expect(message.locator("strong")).toHaveText("Bestie");
    await expect(message.locator("time")).toHaveAttribute("datetime", /T/);
    await expect(message.locator("img")).toHaveAttribute("src", "/bestie.png");
    await toggleTranscript(page);
    await expect(transcript).toHaveCount(0);
    await toggleTranscript(page);

    await expect(
      page.getByRole("log", { name: "Bestie transcript" }),
    ).toContainText("Fixture voice reply.");
    await expect
      .poll(() =>
        f.events.some(
          (event) => event.type === "playback" && event.samples > 0,
        ),
      )
      .toBe(true);
    const wave = page.getByRole("img", { name: "Microphone activity" });
    await expect(wave).toBeVisible();
    await expect(wave.locator(":scope > div")).toHaveCount(2);
    await expect(wave.locator(":scope > div").first()).toHaveCSS(
      "opacity",
      "0.2",
    );
    await expect(wave.locator(":scope > div").first()).toHaveCSS(
      "transform",
      "matrix(-1, 0, 0, 1, 0, 0)",
    );
    await expect(wave.locator("span").first()).toHaveCSS("width", "2px");
    await expect(wave.locator(":scope > div").last()).toHaveCSS("gap", "3px");
    const monochrome = await wave
      .locator("span")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(monochrome).toBe(
      await wave.evaluate((element) => getComputedStyle(element).color),
    );
    const controls = wave.locator("..");
    const geometry = await controls.evaluate((footer) => {
      const [mute, wave, hangup] = footer.children;
      return {
        available:
          footer.clientWidth -
          Number.parseFloat(getComputedStyle(footer).paddingLeft) -
          Number.parseFloat(getComputedStyle(footer).paddingRight),
        occupied:
          hangup.getBoundingClientRect().right -
          mute.getBoundingClientRect().left,
        width: wave.getBoundingClientRect().width,
      };
    });
    expect(geometry.occupied).toBeCloseTo(geometry.available, 0);
    expect(geometry.width).toBeGreaterThan(144);
    await expect(
      wave.locator(":scope > div").last().locator("span"),
    ).toHaveCount(Math.floor((geometry.width + 3) / 5));
    await expect
      .poll(() =>
        wave
          .locator("span")
          .evaluateAll((bars) =>
            bars.some(
              (bar) => Number.parseFloat(bar.style.clipPath.slice(6)) < 19,
            ),
          ),
      )
      .toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() =>
        wave
          .locator("span")
          .evaluateAll((bars) =>
            bars.every(
              (bar) => bar.style.clipPath === "inset(17px 0px round 1px)",
            ),
          ),
      )
      .toBe(true);
    await button(page, "Mute Bestie microphone").click();
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Microphone muted" })
          .locator("span")
          .evaluateAll((bars) =>
            bars.every(
              (bar) => bar.style.clipPath === "inset(19px 0px round 1px)",
            ),
          ),
      )
      .toBe(true);
    await expect(button(page, "Unmute Bestie microphone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await capture(page, testInfo, "muted");
    await button(page, "Relocate Bestie").click();
    await expect(transcript).toContainText("Fixture voice reply.");
    await expect(button(page, "End Bestie conversation")).toBeVisible();
    await button(page, "Bestie call settings").click();
    await expect(
      page.getByRole("menuitemradio", { name: "High", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("menuitemradio", { name: "Off", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(button(page, "End Bestie conversation")).toBeVisible();
    expect(f.children.length).toBe(1);
    await expect.poll(f.microphones).toBe(1);
    await button(page, "Hide Bestie").click();
    await expect.poll(f.microphones).toBe(0);
    await expect
      .poll(
        () =>
          f.children[0].exitCode !== null || f.children[0].signalCode !== null,
      )
      .toBe(true);
    await button(page, "Show Bestie").click();
    await expect(button(page, "Start Bestie voice conversation")).toBeEnabled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("community changes revoke the old call and clear transcripts after both active and ended calls", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await chooseSetting(page, "Ask each time");
    await toggleTranscript(page);
    await start(page, f);
    await expect(page.getByRole("log")).toContainText("Fixture voice reply.");
    f.control({ type: "ask", id: "old", title: "Old community tool" });
    await expect(
      page.getByRole("region", { name: "Bestie tool approval" }),
    ).toBeVisible();
    await button(page, "Select Beta").click();
    await expect(page.getByRole("log")).not.toContainText(
      "Fixture voice reply.",
    );
    await expect(
      page.getByRole("region", { name: "Bestie tool approval" }),
    ).toHaveCount(0);
    await expect.poll(f.microphones).toBe(0);
    await expect
      .poll(
        () =>
          f.children[0].exitCode !== null || f.children[0].signalCode !== null,
      )
      .toBe(true);
    await expect(button(page, "Start Bestie voice conversation")).toBeEnabled();
    await start(page, f);
    expect(f.children.length).toBe(2);
    await expect(page.getByRole("log")).toContainText("Fixture voice reply.");
    await button(page, "End Bestie conversation").click();
    await expect(button(page, "Start Bestie voice conversation")).toBeEnabled();
    await button(page, "Select Alpha").click();
    await expect(page.getByRole("log")).not.toContainText(
      "Fixture voice reply.",
    );
    expect(f.events.filter((event) => event.type === "approval")).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("approval controls forward exact choices and disappear when speech revokes a request", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await chooseSetting(page, "Ask each time");
    await start(page, f);
    f.control({ type: "ask", id: "denied", title: "Read fixture channels" });
    const approval = page.getByRole("region", { name: "Bestie tool approval" });
    await expect(approval).toContainText("Read fixture channels");
    await approval.getByRole("button", { name: "Deny", exact: true }).click();
    await expect
      .poll(() =>
        f.events
          .filter((event) => event.type === "approval")
          .map(({ id, option }) => ({ id, option })),
      )
      .toEqual([{ id: "denied", option: "no" }]);
    await expect(approval).toHaveCount(0);
    f.control({ type: "ask", id: "revoked", title: "Revoked tool" });
    await expect(approval).toContainText("Revoked tool");
    f.control({ type: "cancel" });
    await expect(approval).toHaveCount(0);
    f.control({ type: "ask", id: "allowed", title: "New tool" });
    await expect(approval).toContainText("New tool");
    await approval
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect
      .poll(() =>
        f.events
          .filter((event) => event.type === "approval")
          .map(({ id, option }) => ({ id, option })),
      )
      .toEqual([
        { id: "denied", option: "no" },
        { id: "allowed", option: "yes" },
      ]);
    await expect(approval).toHaveCount(0);
    await button(page, "End Bestie conversation").click();
    await expect.poll(f.microphones).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("automatic approval is the default and reaches the exact ACP tool request without a dialog", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await button(page, "Bestie call settings").click();
    await expect(
      page.getByRole("menuitemradio", { name: "Automatically approve" }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await start(page, f);
    f.control({
      type: "ask",
      id: "automatic",
      title: "Automatic fixture tool",
    });
    await expect
      .poll(() =>
        f.events
          .filter((event) => event.type === "approval")
          .map(({ id, option }) => ({ id, option })),
      )
      .toEqual([{ id: "automatic", option: "yes" }]);
    await expect(
      page.getByRole("region", { name: "Bestie tool approval" }),
    ).toHaveCount(0);
    await button(page, "End Bestie conversation").click();
    await expect.poll(f.microphones).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("transcript occupies the lower half and scrolls beneath a soft edge without moving Bestie", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  try {
    await toggleTranscript(page);
    await start(page, f);
    const transcript = page.getByRole("log", { name: "Bestie transcript" });
    await expect(transcript).toContainText("Fixture voice reply.");
    f.control({ type: "history" });
    await expect(transcript.locator("[data-message-id]")).toHaveCount(21);
    const viewport = transcript.locator("..");
    const identity = page
      .getByRole("img", { name: "Bestie", exact: true })
      .locator("../..");
    const initial = await identity.boundingBox();
    expect((await viewport.boundingBox()).height).toBeCloseTo(
      initial.height,
      0,
    );
    await expect(transcript).toHaveCSS("overflow-y", "auto");
    expect(
      await transcript.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await expect(transcript).toHaveCSS("mask-image", /linear-gradient/);
    expect(
      await viewport.evaluate(
        (element) => getComputedStyle(element, "::after").backdropFilter,
      ),
    ).toBe("blur(2px)");
    await transcript.focus();
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        transcript.evaluate((element) =>
          Math.abs(
            element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ),
      )
      .toBeLessThan(2);
    expect(await identity.boundingBox()).toEqual(initial);
    await transcript.evaluate((element) => {
      element.scrollTop = 110;
    });
    await capture(page, testInfo, "transcript");
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await capture(page, testInfo, "transcript-dark");
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "light";
    });
    // A short panel still divides evenly and keeps the footer outside the scroll area.
    await page.locator("main > div").evaluate((element) => {
      element.style.height = "400px";
    });
    await expect
      .poll(async () => (await viewport.boundingBox()).height)
      .toBeLessThan(initial.height);
    const compact = await identity.boundingBox();
    expect((await viewport.boundingBox()).height).toBeCloseTo(
      compact.height,
      0,
    );
    const footer = await page.locator("footer").boundingBox();
    expect(
      (await viewport.boundingBox()).y + (await viewport.boundingBox()).height,
    ).toBeLessThanOrEqual(footer.y + 1);
    const avatarBox = await page
      .getByRole("img", { name: "Bestie", exact: true })
      .boundingBox();
    expect(avatarBox.y).toBeGreaterThanOrEqual(compact.y);
    expect(avatarBox.y + avatarBox.height).toBeLessThanOrEqual(
      (await viewport.boundingBox()).y,
    );
    await capture(page, testInfo, "transcript-compact");
    await toggleTranscript(page);
    await expect(transcript).toHaveCount(0);
    expect((await identity.boundingBox()).height).toBeCloseTo(
      compact.height * 2,
      0,
    );
  } finally {
    await f.close();
  }
});

test("settings sit beside close and Escape dismisses only the menu", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  try {
    const card = page.getByRole("complementary", {
      name: "Bestie",
      exact: true,
    });
    await expect(card.getByText("Your Bestie", { exact: true })).toHaveCount(0);
    await capture(page, testInfo, "idle");
    const header = card.locator("header");
    await expect(
      header.getByRole("button", { name: "Bestie call settings" }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Close Bestie panel" }),
    ).toBeVisible();
    const settings = header.getByRole("button", {
      name: "Bestie call settings",
    });
    const close = header.getByRole("button", { name: "Close Bestie panel" });
    const settingsBox = await settings.boundingBox();
    const closeBox = await close.boundingBox();
    expect(closeBox.width).toBe(settingsBox.width);
    expect(closeBox.height).toBe(settingsBox.height);
    expect(closeBox.width).toBe(closeBox.height);
    await expect(close).toHaveAttribute("data-icon-shape", "control");
    await expect(close.locator("svg")).toHaveAttribute("width", "18");
    await button(page, "Bestie call settings").click();
    await expect(
      page.getByRole("menuitemradio", { name: "Off", exact: true }),
    ).toBeChecked();
    await capture(page, testInfo, "settings");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(button(page, "Bestie call settings")).toBeFocused();
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
  } finally {
    await f.close();
  }
});
