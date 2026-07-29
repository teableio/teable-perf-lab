// Environment access for the scripts layer.
//
// `requiredEnv` used to be re-declared in ten CI entry points with four
// different error messages ("is required" / "is required." / "must be set" /
// "must be set."), and `env` in five more. A report-stage failure therefore
// read differently depending on which script happened to fail first. These are
// the only two shapes any script needs; keep them here so the wording, the
// empty-string-is-missing rule, and the trim behaviour stay identical.

export const env = (name, fallback = "") => process.env[name] ?? fallback;

// An empty or unset variable is missing. GitHub Actions passes an unset input
// through as "", so treating "" as present would push the failure downstream
// into whatever consumed the blank value.
export const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};
