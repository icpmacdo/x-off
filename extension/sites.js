// The sites X Off treats as "X". Subdomains (mobile.x.com, mobile.twitter.com…) are included.
// t.co is left out on purpose: blocking it would break every shared link that X shortens.
export const SITES = ["x.com", "twitter.com"];

export const URL_PATTERNS = SITES.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);

export function isXUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return SITES.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
