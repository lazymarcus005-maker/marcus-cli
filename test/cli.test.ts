import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import { createRequestPreparationExtension } from "../src/kernel/pi-agent-kernel.js";

describe("macus CLI", () => {
  it("shows help without starting an agent session", async () => {
    const output: string[] = [];
    const result = await runCli(["--help"], {
      write: (text) => output.push(text),
      startSession: async () => {
        assert.fail("help must not start an agent session");
      },
    });

    assert.equal(result, 0);
    assert.match(output.join(""), /Macus Code/);
    assert.match(output.join(""), /macus \[task\]/);
  });

  it("shows the package version without starting an agent session", async () => {
    const output: string[] = [];
    const result = await runCli(["--version"], {
      version: "0.1.0",
      write: (text) => output.push(text),
      startSession: async () => {
        assert.fail("version must not start an agent session");
      },
    });

    assert.equal(result, 0);
    assert.equal(output.join(""), "0.1.0\n");
  });

  it("passes the initial task to the interactive session", async () => {
    let receivedPrompt: string | undefined;
    const result = await runCli(["fix", "the", "bug"], {
      write: () => undefined,
      startSession: async (prompt) => {
        receivedPrompt = prompt;
      },
    });

    assert.equal(result, 0);
    assert.equal(receivedPrompt, "fix the bug");
  });

  it("runs help through the public CLI entrypoint", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Macus Code/);
  });

  it("runs the CLI when launched through an npm-style symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "macus-bin-link-"));
    const command = join(directory, "macus");
    try {
      await symlink(join(process.cwd(), "src/cli.ts"), command);
      const result = spawnSync(process.execPath, ["--import", "tsx", command, "--version"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "0.1.0\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Pi provider-request boundary", () => {
  it("prepares every payload using the registered Pi request hook", () => {
    let requestHandler: ((event: { payload: unknown }) => unknown) | undefined;
    const extension = createRequestPreparationExtension({
      prepareProviderRequest: (payload) => ({
        ...(payload as { messages: string[] }),
        messages: ["budgeted", ...(payload as { messages: string[] }).messages],
      }),
    });
    const fakeApi = {
      on: (event: string, handler: (event: { payload: unknown }) => unknown) => {
        assert.equal(event, "before_provider_request");
        requestHandler = handler;
      },
    };

    extension(fakeApi as never);
    assert.deepEqual(requestHandler?.({ payload: { messages: ["original"] } }), {
      messages: ["budgeted", "original"],
    });
  });
});
