export const loadTeableFieldNames = async ({ endpoint, token, tableId }) => {
  if (!token) return new Set();
  const response = await fetch(
    `${endpoint.replace(/\/+$/, "")}/api/table/${tableId}/field`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Teable field read failed: ${response.status} ${text}`);
  }
  return new Set((JSON.parse(text) ?? []).map((field) => field.name));
};
