export const exitCodeForPairedVerdict = (status) => {
  if (status === "pass") return 0;
  if (status === "regression") return 1;
  return 2;
};
