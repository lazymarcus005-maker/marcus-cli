import { resolve } from "node:path";
import { generateBenchmarkFixture } from "../src/workflow/benchmark-fixture.js";

const outputDirectory = process.argv[2];
if (!outputDirectory) {
  process.stderr.write("Usage: npm run benchmark:fixture -- /path/to/empty-directory\n");
  process.exitCode = 2;
} else {
  try {
    const manifest = await generateBenchmarkFixture({ root: resolve(outputDirectory) });
    process.stdout.write(`Generated ${manifest.fileCount} source files (${manifest.sourceBytes} bytes)\n`);
    process.stdout.write(`Languages: TypeScript=${manifest.languages.typescript}, JavaScript=${manifest.languages.javascript}, C#=${manifest.languages.csharp}\n`);
    process.stdout.write(`Fixture SHA-256: ${manifest.fixtureSha256}\n`);
    process.stdout.write(`Manifest: ${resolve(outputDirectory, ".macus/benchmark/fixture-v1.json")}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown benchmark fixture generation error";
    process.stderr.write(`Could not generate benchmark fixture: ${message}\n`);
    process.exitCode = 1;
  }
}
