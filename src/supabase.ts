import { createClient } from "@supabase/supabase-js";
import { config } from "@/config";

const gotrueFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return fetch(url.replace("/auth/v1/", "/auth/"), init);
};

export const supabase = createClient(config.apiBaseUrl, config.gotrueAnonKey, {
  global: { fetch: gotrueFetch },
  auth: {
    // GoTrue confirmation / recovery links redirect with tokens in the URL hash.
    flowType: "implicit",
    detectSessionInUrl: true,
  },
});
