import { expect, it } from "vitest";
import { validSessionCommand } from "./session-commands.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const event = (body, tags = [["h", id]]) => ({
  kind: 9050,
  created_at: 1,
  content: JSON.stringify(body),
  tags,
});
it("rejects custom session commands", () => {
  expect(validSessionCommand(event({ action: "create", title: "Work" }))).toBe(
    false,
  );
  expect(
    validSessionCommand(
      event({ action: "move", parent_id: id, confirm_history: true }),
    ),
  ).toBe(false);
});
it("allows only ordinary invitations, without extra roles", () => {
  const invite = {
    kind: 9000,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["p", "a".repeat(64)],
    ],
  };
  expect(validSessionCommand(invite)).toBe(true);
  expect(
    validSessionCommand({
      ...invite,
      tags: [...invite.tags, ["role", "admin"]],
    }),
  ).toBe(false);
  expect(validSessionCommand({ ...invite, kind: 9001 })).toBe(false);
});

it("allows only private stream creation marked for Sessions", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  };
  expect(validSessionCommand(create)).toBe(true);
  const child = (description) => ({
    ...create,
    tags: create.tags.map((tag) =>
      tag[0] === "about" ? ["about", description] : tag,
    ),
  });
  expect(
    validSessionCommand(child(`Buzz session (buzz.sessions/v1)\nparent:${id}`)),
  ).toBe(true);
  for (const parent of ["invalid", `${id}\nrole:owner`, `${id}extra`]) {
    expect(
      validSessionCommand(
        child(`Buzz session (buzz.sessions/v1)\nparent:${parent}`),
      ),
    ).toBe(false);
  }
  for (const [index, value] of [
    [2, "open"],
    [3, "dm"],
    [4, "arbitrary"],
    [1, " "],
  ]) {
    expect(
      validSessionCommand({
        ...create,
        tags: create.tags.map((tag, i) =>
          i === index ? [tag[0], value] : tag,
        ),
      }),
    ).toBe(false);
  }
  expect(
    validSessionCommand({
      ...create,
      tags: [...create.tags, ["p", "a".repeat(64)]],
    }),
  ).toBe(false);
  expect(validSessionCommand({ ...create, content: "extra" })).toBe(false);
});

it("accepts one trailing outbox identifier for invitations and rejects ambiguous envelopes", () => {
  const invite = (tags) => ({ kind: 9000, created_at: 1, content: "", tags });
  const h = ["h", id],
    p = ["p", "a".repeat(64)],
    client = ["client-id", id];
  expect(validSessionCommand(invite([h, p, client]))).toBe(true);
  for (const tags of [
    [h, p, client, client],
    [client, h, p],
    [h, p, ["client-id", "invalid"]],
    [h, p, [...client, "extra"]],
  ])
    expect(validSessionCommand(invite(tags))).toBe(false);
});
