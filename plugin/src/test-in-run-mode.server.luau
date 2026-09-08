--!strict
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsRunning() then
	return
end
_G.__JEST__ = true

-- Plugin/CLI protocol version. Must match `STUDIO_PROTOCOL_VERSION` in
-- `src/backends/studio.ts` and `STUDIO_CLI_PROTOCOL_VERSION` in
-- `src/backends/studio-cli.ts`. v7 adds the `runnerTimeoutMs` argv the runner
-- bounds a project's run with and strips before calling Jest, so a v6 plugin
-- handed one runs unbounded and passes the key on to Jest; v6 adds the plugin's
-- own release version to the result and the claim below; v5 added the optional
-- `vmParallel` count: a
-- plugin predating it would run a parallel request sequentially and say
-- nothing, so the handshake is what turns that into an "update the plugin"
-- error. v4 nested the fields the runner adds to Jest's result under `runner`
-- and renamed the frame key `request_id` to `requestId`. The runner validates
-- the version the CLI sent and echoes its own in `EndTest`, so the CLI
-- surfaces a clean error against a mismatched plugin rather than running with
-- stale runtime semantics.
local PROTOCOL_VERSION = 7

-- Written by `scripts/stamp-plugin-version.ts` at build time, and absent from a
-- tree served straight out of source control. Diagnostic only — see the same
-- lookup in `init.server.luau`.
local versionOk, PluginVersion = pcall(require, script.Parent:FindFirstChild("version") :: any)
if not versionOk or typeof(PluginVersion) ~= "string" then
	PluginVersion = "unknown"
end

-- Set by whichever installed copy of the plugin can serve this run. Studio
-- injects a run-mode runner for *every* installed copy, and they all reach
-- `EndTest` for the same run: without a claim, a stale copy's refusal lands
-- first and loses the run for a Studio that also has a working copy. Held on
-- ReplicatedStorage rather than the DataModel because the plugin already
-- carries an attribute there, so the surface is known to work.
local RUN_CLAIM_ATTRIBUTE = "JestRobloxRunClaimed"

-- How long a copy that cannot serve the run waits for a copy that can. Only
-- ever waited out in full when this is the sole installed copy, in which case
-- the mismatch is the run's real cause and has to be reported.
local MISMATCH_DEFER_SECONDS = 3

-- The fork runs the Studio plugin strictly single-VM: the experimental
-- Actor-host (vmHosts) parallel seam was pruned. Every request, including
-- one carrying a `vmParallel` count, runs sequentially through
-- `Runner.runProjects` below.

local testArgs: any = nil

-- Every result (success or failure) echoes `protocolVersion` so the studio-cli
-- host can detect a stale plugin: one predating this echo omits the field and
-- the host rejects it as a version mismatch.
local function endTest(jestOutput: string, gameOutput: string?): ()
	if testArgs and typeof(testArgs.resultsUrl) == "string" and testArgs.resultsUrl ~= "" then
		local postMessage = {
			type = "results",
			requestId = testArgs.requestId or "direct",
			protocolVersion = PROTOCOL_VERSION,
			pluginVersion = PluginVersion,
			gameOutput = gameOutput or "[]",
			jestOutput = jestOutput,
		}
		pcall(function()
			return HttpService:RequestAsync({
				Url = testArgs.resultsUrl,
				Method = "POST",
				Headers = { ["Content-Type"] = "application/json" },
				Body = HttpService:JSONEncode(postMessage),
			})
		end)
		-- Now call EndTest with minimal empty payload so Studio cleanly exits Run Mode
		-- without attempting to marshal the large test result table across VM boundaries
		pcall(function()
			StudioTestService:EndTest({
				protocolVersion = PROTOCOL_VERSION,
				pluginVersion = PluginVersion,
			})
		end)
		return
	end

	local ok, endErr = pcall(function()
		StudioTestService:EndTest({
			jestOutput = jestOutput,
			gameOutput = gameOutput or "[]",
			protocolVersion = PROTOCOL_VERSION,
			pluginVersion = PluginVersion,
		})
	end)
	if not ok then
		warn("[jest-roblox] EndTest failed: " .. tostring(endErr))
	end
end

local function endWithError(err: string): ()
	endTest(HttpService:JSONEncode({ success = false, err = err }), "[]")
end

testArgs = StudioTestService:GetTestArgs()
if testArgs == nil then
	for _ = 1, 50 do
		task.wait(0.1)
		testArgs = StudioTestService:GetTestArgs()
		if testArgs ~= nil then
			break
		end
	end
end

if testArgs == nil then
	return
end

-- Version handshake: reject a missing or mismatched `protocolVersion` before
-- running anything, mirroring the WebSocket `version_mismatch` path. The error
-- envelope still echoes our version (via endTest), so the CLI surfaces the
-- upgrade message either through this error or the version echo.
local clientVersion = if typeof(testArgs.protocolVersion) == "number"
	then testArgs.protocolVersion
	else nil
if clientVersion ~= PROTOCOL_VERSION then
	-- Defer to any installed copy that can serve this run before reporting.
	-- Reporting straight away is what makes a stale copy fatal to a Studio
	-- that also has a working one: `EndTest` is first-past-the-post, and
	-- refusing costs nothing while running the suite takes seconds.
	local deadline = os.clock() + MISMATCH_DEFER_SECONDS
	repeat
		if ReplicatedStorage:GetAttribute(RUN_CLAIM_ATTRIBUTE) ~= nil then
			return
		end

		task.wait(0.05)
	until os.clock() >= deadline

	endWithError(
		"Studio plugin protocol version mismatch — plugin v"
			.. tostring(PROTOCOL_VERSION)
			.. " ("
			.. PluginVersion
			.. "), CLI v"
			.. tostring(clientVersion)
			.. ". Update the jest-roblox Studio plugin to match the CLI."
	)
	return
end

-- Claim the run before doing anything that takes time, so the copies that
-- cannot serve it stand down rather than answering in our place.
ReplicatedStorage:SetAttribute(RUN_CLAIM_ATTRIBUTE, PROTOCOL_VERSION)

local loadStringEnabled = pcall(function()
	loadstring("return true")
end)

if not loadStringEnabled then
	endWithError("LoadString must be enabled in ServerScriptService to run tests")
	return
end

-- Dispatch by payload shape. A `workspace` payload drives the staged
-- materializer (clone each package from the mega-place's `__pkg_stage`, run,
-- reset) via the shared single-process embedded runner — the same code OCALE
-- runs, minus the MemoryStore queue. Otherwise the existing single-/multi-
-- project configs path runs `Runner.runProjects`.
if testArgs.workspace ~= nil then
	local embeddedOk, EmbeddedRunner =
		pcall(require, script.Parent.shared.staging["embedded-runner"])
	if not embeddedOk then
		endWithError(
			"Failed to require shared.staging.embedded-runner: " .. tostring(EmbeddedRunner)
		)
		return
	end

	local runOk, entriesOrErr = pcall(EmbeddedRunner.runEmbedded, script, testArgs.workspace)
	if not runOk then
		endWithError("EmbeddedRunner.runEmbedded threw: " .. tostring(entriesOrErr))
		return
	end

	endTest(HttpService:JSONEncode({ entries = entriesOrErr }), "[]")
	return
end

if testArgs.config == nil or testArgs.config.configs == nil then
	local keysOk, keys = pcall(HttpService.JSONEncode, HttpService, testArgs)
	endWithError(
		"testArgs.config.configs is nil. Keys: " .. (if keysOk then keys else "<unencodable>")
	)
	return
end

local configs = testArgs.config.configs

local requireOk, Runner = pcall(require, script.Parent.shared.runner)
if not requireOk then
	endWithError("Failed to require shared.runner: " .. tostring(Runner))
	return
end

local stubHooksOk, StubHooks = pcall(require, script.Parent.shared["runtime-stub-hooks"])
if not stubHooksOk then
	endWithError("Failed to require shared.runtime-stub-hooks: " .. tostring(StubHooks))
	return
end


-- Per-config injection target lists, parallel to `configs`. The CLI sends a
-- pre-filtered list excluding mount paths whose source tree already has a
-- user-authored `jest.config.luau` synced by Rojo. Empty entry (or missing
-- field) means: skip injection for this config.
local runtimeStubMounts: { { string } } = testArgs.runtimeStubMounts or table.create(#configs, {})


-- The hooks let `Runner.runProjects` inject each config's `jest.config`
-- ModuleScripts just-in-time and destroy them before the next config runs, so
-- nested-project mounts (e.g. `ReplicatedStorage` and `ReplicatedStorage/Foo`)
-- never have stubs in DataModel simultaneously — which would let Jest's
-- parent-traversal config lookup resolve the wrong project's config.
local hooks, cleanupAllStubs = StubHooks.create(runtimeStubMounts)

local runOk, entriesOrErr = pcall(Runner.runProjects, script, configs, hooks)
-- Defensive: also clear `_G` even if every afterConfig hook already cleaned
-- per-config. Belt-and-suspenders against a hook-call that yielded early.
cleanupAllStubs()
if not runOk then
	endWithError("Runner.runProjects threw: " .. tostring(entriesOrErr))
	return
end

endTest(HttpService:JSONEncode({ entries = entriesOrErr }), "[]")
