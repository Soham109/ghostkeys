/**
 * Outbound links.
 * DOWNLOAD_URL -> the GitHub release (real, opens in a new tab). Everything is free during the beta, so it is
 * the actual download, not a placeholder.
 * BUY_URL -> still opens the sheet (components/site/GetSheet.tsx), which now explains it is free during the
 * beta and offers the same real download, since checkout does not exist yet.
 * SALES_URL -> a sales contact, SOURCE_URL -> the open-source detection core repo.
 */
export const DOWNLOAD_URL = "https://github.com/Soham109/ghostkeys/releases/latest";
export const BUY_URL = "#get-pro";
export const SALES_URL = "/faq/";
export const SOURCE_URL = "/privacy/";

/** Production origin: canonical links, og:image and the sitemap resolve against it. */
export const SITE_ORIGIN = "https://ghostkeys-nine.vercel.app";
