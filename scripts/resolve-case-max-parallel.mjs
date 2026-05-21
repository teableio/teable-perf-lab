const rawMaxParallel = process.env.PERF_LAB_MAX_PARALLEL?.trim() ?? "";

if (!rawMaxParallel || rawMaxParallel === "0") {
  process.stdout.write("256");
  process.exit(0);
}

const maxParallel = Number(rawMaxParallel);

if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
  throw new Error(
    `Unsupported max_parallel: ${rawMaxParallel}. Use a positive integer, or 0 for GitHub Actions default.`,
  );
}

process.stdout.write(String(maxParallel));
