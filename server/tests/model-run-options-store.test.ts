import { expect, test } from "bun:test";
import { createAgentModelService } from "../src/agents/model-selection";

function fixture(protocol: "openai" | "anthropic" = "openai") {
  const row = {
    id: "bot",
    type: "built_in",
    override: { model: "vendor/model", futureSetting: true } as Record<
      string,
      unknown
    >,
  };
  let catalogReads = 0;
  const profiles = { get: async () => profile, getWithin: async () => profile };
  const profile = { deletedAt: null, systemOwned: false, ownerUserId: "owner" };
  const database = {
    select(projection: Record<string, unknown>) {
      const query = {
        from: () => query,
        where: () => query,
        innerJoin: () => query,
        for: () => query,
        then(resolve: (rows: unknown[]) => unknown) {
          return Promise.resolve(
            resolve([
              Object.fromEntries(
                Object.keys(projection).map((key) => [
                  key,
                  row[key as keyof typeof row],
                ]),
              ),
            ]),
          );
        },
      };
      return query;
    },
    update: () => ({
      set: (value: { override: Record<string, unknown> }) => ({
        where: async () => {
          row.override = value.override;
        },
      }),
    }),
    transaction: async (run: (tx: unknown) => unknown) => run(database),
  };
  const create = () =>
    createAgentModelService({
      database,
      profiles,
      resolveDefaultModel: async () => "vendor/default",
      resolveProtocol: async () => protocol,
      catalog: {
        list: async () => {
          catalogReads++;
          return { models: [{ id: "vendor/second" }], fetchedAt: 1 };
        },
      },
    } as unknown as Parameters<typeof createAgentModelService>[0]);
  return { row, create, profile, catalogReads: () => catalogReads };
}
const owner = { id: "owner", role: "user" as const };

test("partial run settings persist across service reloads, survive model changes, and clear independently", async () => {
  const f = fixture();
  expect(
    await f
      .create()
      .set(owner, "bot", undefined, {
        reasoningEffort: "high",
        fastMode: true,
      }),
  ).toMatchObject({
    model: "vendor/model",
    reasoningEffort: "high",
    fastMode: true,
  });
  expect(f.catalogReads()).toBe(0);
  expect(await f.create().resolveSettings("bot")).toEqual({
    model: "vendor/model",
    reasoningEffort: "high",
    fastMode: true,
  });
  await f.create().set(owner, "bot", "vendor/second");
  expect(f.row.override).toEqual({
    model: "vendor/second",
    futureSetting: true,
    reasoningEffort: "high",
    fastMode: true,
  });
  await f
    .create()
    .set(owner, "bot", null, { reasoningEffort: null, fastMode: false });
  expect(f.row.override).toEqual({ futureSetting: true, fastMode: false });
  expect(await f.create().get(owner, "bot")).toMatchObject({
    model: "vendor/default",
    reasoningEffort: null,
    fastMode: false,
  });
});

test("run settings follow ownership, deletion, and protocol restrictions", async () => {
  const f = fixture();
  await expect(
    f
      .create()
      .set({ id: "other", role: "user" }, "bot", undefined, { fastMode: true }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    fixture("anthropic")
      .create()
      .set(owner, "bot", undefined, { fastMode: true }),
  ).rejects.toMatchObject({ status: 400 });
  expect(await fixture("anthropic").create().get(owner, "bot")).toMatchObject({
    supportsRunOptions: false,
  });
  f.profile.deletedAt = new Date() as unknown as null;
  await expect(
    f.create().set(owner, "bot", undefined, { reasoningEffort: "high" }),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.row.override).toEqual({
    model: "vendor/model",
    futureSetting: true,
  });
});
