import { runComplexitySeriesCli } from './complexitySeries/cli';

void runComplexitySeriesCli(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(
      `${JSON.stringify({ verdict: result.report.verdict, jsonPath: result.jsonPath, markdownPath: result.markdownPath, calibrationSha256: result.calibrationSha256 })}\n`
    );
    process.exitCode = result.exitCode;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
