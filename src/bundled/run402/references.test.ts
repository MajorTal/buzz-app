import { expect, it } from "vitest";
import { parseRun402Site } from "./references";

it("recognizes tenant hosts on both managed suffixes and keeps the shared URL intact", () => {
  for (const [url, host, label] of [
    [
      "https://shared-todo.run402.com/",
      "shared-todo.run402.com",
      "shared-todo",
    ],
    ["https://my-app.run402.app", "my-app.run402.app", "my-app"],
    [
      "https://my-app--br-x1y2.run402.com/todo?tab=open#top",
      "my-app--br-x1y2.run402.com",
      "my-app--br-x1y2",
    ],
    ["https://a1.run402.com/deep/path", "a1.run402.com", "a1"],
  ] as const) {
    const site = parseRun402Site(url);
    expect(site?.host).toBe(host);
    expect(site?.label).toBe(label);
  }
  expect(
    parseRun402Site("https://my-app--br-x1y2.run402.com/todo?tab=open#top")
      ?.url,
  ).toBe("https://my-app--br-x1y2.run402.com/todo?tab=open#top");
});

it("refuses platform hosts, lookalikes, credentials, ports and non-HTTPS links", () => {
  for (const url of [
    "https://run402.com/",
    "https://run402.app/",
    "https://www.run402.com/",
    "https://api.run402.com/projects/v1",
    "https://console.run402.com/orgs/x/projects/y",
    "https://git.run402.com/org/repo",
    "https://docs.run402.com/",
    "https://admin.run402.com/",
    "https://status.run402.com/",
    "https://deep.my-app.run402.com/",
    "https://my-app.run402.com.evil.example/",
    "https://my-app.run402.company/",
    "https://user:pw@my-app.run402.com/",
    "https://user@my-app.run402.com/",
    "https://my-app.run402.com:8443/",
    "http://my-app.run402.com/",
    "https://-bad.run402.com/",
    "https://bad-.run402.com/",
    "https://my_app.run402.com/",
    "not a url",
  ])
    expect(parseRun402Site(url), url).toBeUndefined();
});
