import { expect, test, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AgentSecurityService, type SecurityHost } from "./security";

test("plugin scope revokes a late native registration and cannot leave an enabled provider", async () => {
  const ctx = new Context();
  let complete!: (v: { lease: string }) => void;
  const pending = new Promise<{ lease: string }>((r) => {
    complete = r;
  });
  const requests: Record<string, unknown>[] = [];
  const host: SecurityHost = async <T>(request: Record<string, unknown>) => {
    requests.push(request);
    return (request.kind === "register" ? await pending : {}) as T;
  };
  new AgentSecurityService(ctx, host);
  let registration: Promise<unknown> | undefined;
  const plugin = ctx
    .extend({ pluginOwner: { id: "fixture.security", revision: "1" } })
    .plugin({
      inject: ["agentSecurity"],
      apply(scope: Context) {
        registration = scope.agentSecurity.register("/fixture/launcher");
        void registration.catch(() => {});
      },
    });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const disposal = plugin.dispose();
  complete({ lease: "lease-one" });
  await disposal;
  await expect(registration).rejects.toThrow("disabled");
  expect(requests).toContainEqual({
    kind: "unregister",
    provider: "fixture.security",
    lease: "lease-one",
  });
  await ctx.fiber.dispose();
});

test("a retained service cannot register after its plugin scope is disposed", async () => {
  const ctx = new Context();
  const host = vi.fn(async () => ({ lease: "unexpected" }));
  new AgentSecurityService(ctx, host as SecurityHost);
  let service: Context["agentSecurity"] | undefined;
  const plugin = ctx
    .extend({ pluginOwner: { id: "fixture.security", revision: "1" } })
    .plugin({
      inject: ["agentSecurity"],
      apply(scope: Context) {
        service = scope.agentSecurity;
      },
    });
  await vi.waitFor(() => expect(service).toBeDefined());
  await plugin.dispose();
  if (!service) throw new Error("Plugin service was not initialized");
  await expect(service.register("/fixture/launcher")).rejects.toThrow(
    "inactive context",
  );
  expect(host).not.toHaveBeenCalled();
  await ctx.fiber.dispose();
  expect(host).not.toHaveBeenCalled();
});

test("explicit and scope disposal unregister a successful registration only once", async () => {
  const ctx = new Context();
  const requests: Record<string, unknown>[] = [];
  new AgentSecurityService(ctx, async <T>(request: Record<string, unknown>) => {
    requests.push(request);
    return { lease: "lease-one" } as T;
  });
  let registration:
    | ReturnType<Context["agentSecurity"]["register"]>
    | undefined;
  const plugin = ctx
    .extend({ pluginOwner: { id: "fixture.security", revision: "1" } })
    .plugin({
      inject: ["agentSecurity"],
      apply(scope: Context) {
        registration = scope.agentSecurity.register("/fixture/launcher");
      },
    });
  await vi.waitFor(() => expect(registration).toBeDefined());
  if (!registration) throw new Error("Plugin registration was not started");
  const provider = await registration;
  await provider.dispose();
  await provider.dispose();
  await plugin.dispose();
  await ctx.fiber.dispose();
  expect(requests).toEqual([
    {
      kind: "register",
      provider: "fixture.security",
      executable: "/fixture/launcher",
    },
    { kind: "unregister", provider: "fixture.security", lease: "lease-one" },
  ]);
});

test("failed registration does not unregister a provider it never acquired", async () => {
  const ctx = new Context();
  const host = vi.fn(async () => {
    throw new Error("launcher unavailable");
  });
  new AgentSecurityService(ctx, host);
  let registration: Promise<unknown> | undefined;
  const plugin = ctx
    .extend({ pluginOwner: { id: "fixture.security", revision: "1" } })
    .plugin({
      inject: ["agentSecurity"],
      apply(scope: Context) {
        registration = scope.agentSecurity.register("/fixture/launcher");
        void registration.catch(() => {});
      },
    });
  await vi.waitFor(() => expect(registration).toBeDefined());
  await expect(registration).rejects.toThrow("launcher unavailable");
  await plugin.dispose();
  await ctx.fiber.dispose();
  expect(host).toHaveBeenCalledTimes(1);
});
