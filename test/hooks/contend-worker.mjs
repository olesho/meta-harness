// Child-process worker for the true-parallel contention test. Spawned by
// settingsjson.test.ts on Node >=22 (native TS execution). Each process hammers
// ensureSettingsJSONHooks on the SAME config, so the O_EXCL sentinel + atomic
// rename are exercised under real OS-level parallelism.
//
// argv: [node, thisFile, modulePath, configPath, iterations]
const [, , modulePath, configPath, iterationsRaw] = process.argv;
const iterations = Number(iterationsRaw);

const { ensureSettingsJSONHooks, renderHookCommand } = await import(modulePath);

const event = "Stop";
const command = renderHookCommand({
  nodePath: "/usr/bin/node",
  distDir: "/opt/dist",
  event,
});

for (let i = 0; i < iterations; i++) {
  ensureSettingsJSONHooks(configPath, {
    [event]: [{ matcher: "*", hooks: [{ type: "command", command }] }],
  });
}
