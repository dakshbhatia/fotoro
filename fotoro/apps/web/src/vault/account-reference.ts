import {get} from "../exchange/cache";

export async function hasRememberedAccount() {
  const reference = await get<unknown>("settings", "last-account");
  return typeof reference === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(reference);
}
