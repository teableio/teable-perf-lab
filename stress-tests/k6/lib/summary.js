export function makeHandleSummary(defaultPath) {
  return function (data) {
    var path = __ENV.SUMMARY_PATH || defaultPath;
    return {
      [path]: JSON.stringify(data, null, 2),
    };
  };
}
