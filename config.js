// Public settings for the dashboard page.
//
// Everything in this file is visible to anyone who opens the site. Only put the
// *browser* API key here, and restrict it in Google Cloud to this site's URL and
// to the YouTube Data API v3. Never put the OAuth client secret or refresh token
// here; those live in GitHub Secrets and are only used by the scheduled job.
window.DASHBOARD_CONFIG = {
  // Google Cloud API key used by the "Refresh live" button.
  apiKey: "",

  // YouTube channel ID (starts with "UC"). If left empty, the ID saved by the
  // scheduled job in data/latest.json is used.
  channelId: "UCFcBDqa1WtDlBExpx_y0nAQ",

  // Number formatting. "en-IN" groups as 12,34,567; use "en-US" for 1,234,567.
  locale: "en-IN",

  // Minimum seconds between live refreshes, to protect the daily API quota.
  refreshCooldownSeconds: 30,

  // How often the open page re-reads the data files written by the scheduled job.
  autoReloadMinutes: 5,
};
